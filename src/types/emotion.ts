/**
 * Emotion, expression and gesture vocabulary (PLAN §6.2, §6.4, §5.4).
 *
 * Everything the model is allowed to emit lives here as a closed allowlist.
 * Anything outside these lists is rejected by the response validator — the model
 * can never select an arbitrary file, path or executable action.
 */

export const EMOTIONS = [
  'neutral',
  'happy',
  'excited',
  'sad',
  'concerned',
  'angry',
  'confused',
  'curious',
  'surprised',
  'playful',
  'thinking',
  'sleepy',
] as const;
export type Emotion = (typeof EMOTIONS)[number];

/** Expression presets, aligned with the VRM 1.0 preset expression names. */
export const EXPRESSIONS = ['neutral', 'happy', 'sad', 'angry', 'surprised', 'relaxed'] as const;
export type ExpressionName = (typeof EXPRESSIONS)[number];

/** Mouth-viseme expressions used by the fallback avatar when lip sync is active. */
export const MOUTH_EXPRESSIONS = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;

export const GESTURES = [
  'none',
  'wave',
  'nod',
  'nod_slow',
  'shake_head',
  'head_tilt',
  'celebrate',
  'shrug',
  'point_up',
  'thumb_up',
  'lean_in',
  'think_pose',
] as const;
export type Gesture = (typeof GESTURES)[number];

export const VOICE_PACES = ['slow', 'normal', 'fast'] as const;
export type VoicePace = (typeof VOICE_PACES)[number];

export const MEMORY_CATEGORIES = [
  'identity',
  'preference',
  'project',
  'milestone',
  'relationship',
  'health',
  'schedule',
  'other',
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_SCOPES = ['user', 'character'] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

/**
 * Default emotion → expression mapping. The expression controller tries the
 * mapped preset, then `neutral`, then whatever the loaded avatar actually has.
 */
export const EMOTION_TO_EXPRESSION: Record<Emotion, ExpressionName> = {
  neutral: 'neutral',
  happy: 'happy',
  excited: 'happy',
  sad: 'sad',
  concerned: 'sad',
  angry: 'angry',
  confused: 'surprised',
  curious: 'relaxed',
  surprised: 'surprised',
  playful: 'happy',
  thinking: 'relaxed',
  sleepy: 'relaxed',
};

/** Gestures that are safe to trigger without a timestamp (PLAN §10.2). */
export const SAFE_IMMEDIATE_GESTURES: readonly Gesture[] = ['none', 'nod', 'head_tilt'];

/** Intensity used when the model omits it. */
export const DEFAULT_INTENSITY = 0.4;

export function isEmotion(value: unknown): value is Emotion {
  return typeof value === 'string' && (EMOTIONS as readonly string[]).includes(value);
}

export function isExpression(value: unknown): value is ExpressionName {
  return typeof value === 'string' && (EXPRESSIONS as readonly string[]).includes(value);
}

export function isGesture(value: unknown): value is Gesture {
  return typeof value === 'string' && (GESTURES as readonly string[]).includes(value);
}

export function isVoicePace(value: unknown): value is VoicePace {
  return typeof value === 'string' && (VOICE_PACES as readonly string[]).includes(value);
}

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value);
}
