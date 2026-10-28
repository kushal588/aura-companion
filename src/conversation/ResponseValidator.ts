import { isEmotion, isExpression, isGesture, isVoicePace, isMemoryCategory, isMemoryScope, EMOTION_TO_EXPRESSION } from '../types/emotion';
import type { Emotion, ExpressionName, Gesture, VoicePace } from '../types/emotion';
import { TURN_LIMITS, TURN_SCHEMA_VERSION, type StructuredTurn, type TurnSegment } from '../types/turn';
import { clampText, clampUnit, normalizeWhitespace, stripControlTags } from '../utils/text';

/**
 * Strict validation of model output (PLAN §6.2).
 *
 * Rules: closed enumerations, bounded lengths, no paths, no executable content.
 * Malformed output is rejected; the caller retries once with a repair
 * instruction and then falls back to plain neutral text — the user never sees
 * raw JSON or control tags.
 */

export interface ValidationSuccess {
  ok: true;
  turn: StructuredTurn;
  issues: string[];
}

export interface ValidationFailure {
  ok: false;
  issues: string[];
  /** Best-effort plain text extracted from the broken response, if any. */
  salvagedText?: string;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

export function validateTurn(raw: string, fallbackTurnId: string): ValidationResult {
  const issues: string[] = [];
  const candidate = extractJsonCandidate(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return {
      ok: false,
      issues: ['Response was not valid JSON'],
      salvagedText: stripControlTags(raw).slice(0, TURN_LIMITS.maxTurnChars),
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, issues: ['Response JSON was not an object'] };
  }

  const record = parsed as Record<string, unknown>;
  const rawSegments = record['segments'];
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    const salvage = firstString(record['text']) ?? firstString(record['message']);
    if (salvage) {
      issues.push('Response had no segments; used plain text fallback');
      return {
        ok: true,
        issues,
        turn: plainTextTurn(salvage, fallbackTurnId, 'repaired'),
      };
    }
    return { ok: false, issues: ['Response contained no segments'] };
  }

  const segments: TurnSegment[] = [];
  let totalChars = 0;
  const limitedSegments = rawSegments.slice(0, TURN_LIMITS.maxSegments);
  if (rawSegments.length > TURN_LIMITS.maxSegments) {
    issues.push(`Response had ${rawSegments.length} segments; kept first ${TURN_LIMITS.maxSegments}`);
  }

  for (const [index, rawSegment] of limitedSegments.entries()) {
    if (typeof rawSegment !== 'object' || rawSegment === null) {
      issues.push(`Segment ${index} was not an object and was dropped`);
      continue;
    }
    const segment = rawSegment as Record<string, unknown>;
    const text = sanitizeSpokenText(segment['text']);
    if (!text) {
      issues.push(`Segment ${index} had no usable text and was dropped`);
      continue;
    }
    if (totalChars + text.length > TURN_LIMITS.maxTurnChars) {
      issues.push('Response exceeded the maximum turn length; remaining segments dropped');
      break;
    }
    totalChars += text.length;

    const emotion: Emotion = isEmotion(segment['emotion']) ? segment['emotion'] : 'neutral';
    if (!isEmotion(segment['emotion'])) {
      issues.push(`Segment ${index} used unknown emotion; defaulted to neutral`);
    }
    const intensity = clampUnit(Number(segment['intensity']), 0.4);
    const expression: ExpressionName = isExpression(segment['expression'])
      ? segment['expression']
      : EMOTION_TO_EXPRESSION[emotion];
    const gesture: Gesture = isGesture(segment['gesture']) ? segment['gesture'] : 'none';
    const voiceRecord =
      typeof segment['voice'] === 'object' && segment['voice'] !== null
        ? (segment['voice'] as Record<string, unknown>)
        : {};
    const pace: VoicePace = isVoicePace(voiceRecord['pace']) ? voiceRecord['pace'] : 'normal';

    segments.push({
      id: sanitizeId(segment['id'], index),
      text,
      displayText: stripControlTags(text),
      emotion,
      intensity,
      expression,
      gesture,
      voice: {
        style: clampText(normalizeWhitespace(String(voiceRecord['style'] ?? '')), TURN_LIMITS.maxStyleChars),
        pace,
      },
    });
  }

  if (segments.length === 0) {
    return { ok: false, issues: [...issues, 'No usable segments after validation'] };
  }

  const memoryCandidates = validateMemoryCandidates(record['memoryCandidates'], issues);

  return {
    ok: true,
    issues,
    turn: {
      schemaVersion: Number(record['schemaVersion']) || TURN_SCHEMA_VERSION,
      turnId: firstString(record['turnId']) ?? fallbackTurnId,
      segments,
      memoryCandidates,
      origin: issues.length > 0 ? 'repaired' : 'model',
      issues,
    },
  };
}

function validateMemoryCandidates(raw: unknown, issues: string[]): StructuredTurn['memoryCandidates'] {
  if (!Array.isArray(raw)) return [];
  const candidates: StructuredTurn['memoryCandidates'] = [];
  for (const [index, candidate] of raw.slice(0, TURN_LIMITS.maxMemoryCandidates).entries()) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const record = candidate as Record<string, unknown>;
    const content = clampText(normalizeWhitespace(String(record['content'] ?? '')), TURN_LIMITS.maxMemoryChars);
    if (!content) continue;
    if (looksLikeSecret(content) || looksLikePath(content)) {
      issues.push(`Memory candidate ${index} looked like a secret or path and was rejected`);
      continue;
    }
    candidates.push({
      content,
      category: isMemoryCategory(record['category']) ? record['category'] : 'other',
      scope: isMemoryScope(record['scope']) ? record['scope'] : 'character',
      confidence: clampUnit(Number(record['confidence']), 0.5),
      importance: clampUnit(Number(record['importance']), 0.5),
    });
  }
  return candidates;
}

/** Plain text fallback turn: neutral motion, no metadata, never tag-laden. */
export function plainTextTurn(
  text: string,
  turnId: string,
  origin: StructuredTurn['origin'] = 'fallback',
): StructuredTurn {
  const cleaned = stripControlTags(normalizeWhitespace(text));
  return {
    schemaVersion: TURN_SCHEMA_VERSION,
    turnId,
    segments: [
      {
        id: 's1',
        text: cleaned,
        displayText: cleaned,
        emotion: 'neutral',
        intensity: 0.3,
        expression: 'neutral',
        gesture: 'none',
        voice: { style: '', pace: 'normal' },
      },
    ],
    memoryCandidates: [],
    origin,
  };
}

/** Instruction used for the single repair retry after invalid output. */
export function buildRepairInstruction(issues: string[], schemaHint: string): string {
  return [
    'Your previous response could not be used.',
    ...issues.map((issue) => `- ${issue}`),
    'Reply again with valid JSON only, matching this schema:',
    schemaHint,
  ].join('\n');
}

function sanitizeSpokenText(value: unknown): string {
  if (typeof value !== 'string') return '';
  const withoutControlTags = stripControlTags(value);
  return clampText(normalizeWhitespace(withoutControlTags));
}

function sanitizeId(value: unknown, index: number): string {
  if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(value)) return value;
  return `s${index + 1}`;
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function looksLikeSecret(text: string): boolean {
  return /(api[\s_-]?key|password|passphrase|secret|token|bearer)/i.test(text);
}

function looksLikePath(text: string): boolean {
  return /(^|\s)(\/[a-z]|[a-z]:\\|file:\/\/|\.\.\/)/i.test(text);
}
