/**
 * Text helpers: control-tag hygiene, length bounds and rough token estimates.
 */

import { TURN_LIMITS } from '../types/turn';

/** Matches `$emotion$` / `#voice#` authoring shorthand anywhere in a string. */
const SHORTHAND = /[$#][a-z_]{2,24}[$#]/gi;

/**
 * True when a string still contains control shorthand. Used as a release gate:
 * control tags must never reach speech or the visible transcript (PLAN §14.3).
 */
export function containsControlTags(text: string): boolean {
  return SHORTHAND.test(text);
}

/** Remove any leaked control shorthand from text that is about to be shown. */
export function stripControlTags(text: string): string {
  return text.replace(SHORTHAND, ' ').replace(/\s{2,}/g, ' ').trim();
}

/** Remove inline TTS non-speech tags like `<short pause>` from visible text. */
export function stripVocalTags(text: string): string {
  return text.replace(/<[a-z][a-z -]{1,24}>/gi, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function clampText(text: string, max: number = TURN_LIMITS.maxSegmentChars): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function clampUnit(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

/** Rough token estimate (~4 chars/token) for budget checks and diagnostics. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateToTokenBudget(text: string, tokenBudget: number): string {
  const charBudget = Math.max(0, tokenBudget * 4);
  if (text.length <= charBudget) return text;
  return `${text.slice(0, Math.max(0, charBudget - 1)).trimEnd()}…`;
}

/** Trim a transcript that may end mid-sentence, for provisional live captions. */
export function looksComplete(text: string): boolean {
  return /[.!?…]["')\]]?$/.test(text.trim());
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function titleFromFirstMessage(text: string, fallback = 'New chat'): string {
  const cleaned = normalizeWhitespace(stripControlTags(text));
  if (!cleaned) return fallback;
  return cleaned.length > 48 ? `${cleaned.slice(0, 47)}…` : cleaned;
}
