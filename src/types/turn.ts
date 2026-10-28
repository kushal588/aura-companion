import type { Emotion, ExpressionName, Gesture, MemoryCategory, MemoryScope, VoicePace } from './emotion';

/**
 * The validated turn schema (PLAN §6.2). This is the only channel through which
 * the language model may steer the avatar. `schemas/turn.schema.json` mirrors
 * these types and is what the Gemini adapter sends as `responseSchema`.
 */

export const TURN_SCHEMA_VERSION = 1;

export interface TurnSegmentVoice {
  /** Free-text style hint, e.g. "bright and energetic". Bounded and sanitised. */
  style: string;
  pace: VoicePace;
}

export interface TurnSegment {
  id: string;
  /** Verbatim spoken text. May contain inline TTS tags such as `<short pause>`. */
  text: string;
  /** Text for display and logs: control tags and inline vocal tags removed. */
  displayText: string;
  emotion: Emotion;
  intensity: number;
  expression: ExpressionName;
  gesture: Gesture;
  voice: TurnSegmentVoice;
}

export interface MemoryCandidate {
  content: string;
  category: MemoryCategory;
  scope: MemoryScope;
  confidence: number;
  importance: number;
}

export interface StructuredTurn {
  schemaVersion: number;
  turnId: string;
  segments: TurnSegment[];
  memoryCandidates: MemoryCandidate[];
  /** How the turn was produced — surfaced in diagnostics, never spoken. */
  origin: 'model' | 'repaired' | 'fallback';
  /** Present when the turn was downgraded, for the diagnostics panel. */
  issues?: string[];
}

/** Hard bounds enforced on every model response. */
export const TURN_LIMITS = {
  maxSegments: 12,
  maxSegmentChars: 1200,
  maxTurnChars: 6000,
  maxStyleChars: 120,
  maxMemoryCandidates: 6,
  maxMemoryChars: 280,
  minIntensity: 0,
  maxIntensity: 1,
} as const;

/** Diagnostics record for one model response (PLAN §3.4 "Developer diagnostics"). */
export interface TurnDiagnostics {
  requestedAt: string;
  latencyMs: number;
  modelId: string;
  attempt: number;
  origin: StructuredTurn['origin'];
  issues: string[];
  promptTokensEstimate: number;
  responseTokensEstimate: number;
  memoriesUsed: Array<{ id: string; content: string }>;
}
