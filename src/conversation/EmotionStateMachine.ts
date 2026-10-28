import type { Emotion } from '../types/emotion';
import { EMOTION_TO_EXPRESSION, SAFE_IMMEDIATE_GESTURES } from '../types/emotion';
import type { AvatarEventKind, CharacterEvent } from '../types/events';
import type { MoodState } from '../types/entities';
import type { Gesture } from '../types/emotion';

export interface EmotionStateMachineOptions {
  /** Minimum time before a new emotion may replace the current one. */
  minDwellMs?: number;
  /** Seconds of no interaction before the mood fades to neutral. */
  decayAfterMs?: number;
  /** Intensity delta required to override the current emotion early. */
  hysteresis?: number;
  /** How fast mood intensity decays toward neutral. */
  decayRatePerSecond?: number;
}

/**
 * Transient mood with smoothing, a minimum dwell time and hysteresis, so the
 * face cannot oscillate between emotions (PLAN §6.4).
 *
 * The mood is presentation state only. It is never persisted as a claim that
 * the character has ongoing feelings.
 */
export class EmotionStateMachine {
  private mood: MoodState;
  private readonly options: Required<EmotionStateMachineOptions>;
  private gestureHistory: Array<{ gesture: Gesture; at: number }> = [];

  constructor(options: EmotionStateMachineOptions = {}, initial?: Partial<MoodState>) {
    this.options = {
      minDwellMs: options.minDwellMs ?? 450,
      decayAfterMs: options.decayAfterMs ?? 9000,
      hysteresis: options.hysteresis ?? 0.18,
      decayRatePerSecond: options.decayRatePerSecond ?? 0.35,
    };
    this.mood = {
      emotion: initial?.emotion ?? 'neutral',
      intensity: initial?.intensity ?? 0,
      lastChangedAt: initial?.lastChangedAt ?? 0,
      sourceTurnId: initial?.sourceTurnId,
    };
  }

  get current(): MoodState {
    return { ...this.mood };
  }

  /**
   * Apply a new emotion. Returns the mood the renderer should use now, which may
   * still be the previous one while the dwell time has not elapsed.
   */
  apply(params: { emotion: Emotion; intensity: number; turnId?: string; now: number }): MoodState {
    const { emotion, intensity, turnId, now } = params;
    const sameEmotion = emotion === this.mood.emotion;
    const elapsed = now - this.mood.lastChangedAt;
    // A strong *incoming* reading may override the dwell window; a quiet one may
    // not. That asymmetry is what stops the face flickering on every word.
    const strongEnough =
      intensity >= 0.6 ||
      (intensity > this.mood.intensity &&
        Math.abs(intensity - this.mood.intensity) >= this.options.hysteresis);

    if (sameEmotion) {
      // Keep the strongest reading of the same emotion.
      this.mood = {
        ...this.mood,
        intensity: Math.max(this.mood.intensity, intensity),
        sourceTurnId: turnId ?? this.mood.sourceTurnId,
      };
      return this.current;
    }

    const mayChange =
      elapsed >= this.options.minDwellMs ||
      intensity >= 0.6 ||
      this.mood.emotion === 'neutral';
    if (!mayChange && !strongEnough) {
      return this.current;
    }

    this.mood = {
      emotion,
      intensity,
      lastChangedAt: now,
      sourceTurnId: turnId ?? this.mood.sourceTurnId,
    };
    return this.current;
  }

  /** Fade toward neutral between turns; never below a small resting value. */
  tick(now: number, deltaSeconds: number): MoodState {
    if (this.mood.emotion === 'neutral') return this.current;
    if (now - this.mood.lastChangedAt < this.options.decayAfterMs) return this.current;
    const next = Math.max(0, this.mood.intensity - this.options.decayRatePerSecond * deltaSeconds);
    if (next <= 0.02) {
      this.mood = { emotion: 'neutral', intensity: 0, lastChangedAt: now };
    } else {
      this.mood = { ...this.mood, intensity: next };
    }
    return this.current;
  }

  /**
   * Cooldown queue: prevents the same gesture repeating inside its window and
   * suppresses any gesture while another is playing (PLAN §6.4).
   */
  allowGesture(gesture: Gesture, now: number, cooldownMs = 3500): boolean {
    if (gesture === 'none') return true;
    this.gestureHistory = this.gestureHistory.filter((entry) => now - entry.at < cooldownMs * 2);
    const recent = this.gestureHistory.find((entry) => entry.gesture === gesture);
    if (recent && now - recent.at < cooldownMs) return false;
    this.gestureHistory.push({ gesture, at: now });
    return true;
  }

  reset(now = 0): MoodState {
    this.mood = { emotion: 'neutral', intensity: 0, lastChangedAt: now };
    this.gestureHistory = [];
    return this.current;
  }
}

/** Turn a validated segment into the ordered events for the avatar scheduler. */
export function buildSegmentEvents(params: {
  sessionId: string;
  turnId: string;
  segmentId: string;
  emotion: Emotion;
  intensity: number;
  gesture: Gesture;
  startSeq: number;
  atAudioSeconds: number;
  /** Spoken duration of this segment, used to place the "speaking end" event. */
  durationSeconds?: number;
}): CharacterEvent[] {
  const events: CharacterEvent[] = [];
  let seq = params.startSeq;
  const push = (kind: AvatarEventKind, value: string, extra: Partial<CharacterEvent> = {}): void => {
    events.push({
      sessionId: params.sessionId,
      turnId: params.turnId,
      segmentId: params.segmentId,
      seq,
      atAudioSeconds: params.atAudioSeconds,
      kind,
      value,
      ...extra,
    });
    seq += 1;
  };

  push('speaking', 'start');
  push('emotion', params.emotion, { intensity: params.intensity });
  push('expression', EMOTION_TO_EXPRESSION[params.emotion], { intensity: params.intensity });
  if (params.gesture !== 'none') {
    push('gesture', params.gesture);
  }
  push('speaking', 'end', { atAudioSeconds: params.atAudioSeconds + (params.durationSeconds ?? 0.001) });
  return events;
}

export function isSafeImmediate(gesture: Gesture): boolean {
  return SAFE_IMMEDIATE_GESTURES.includes(gesture);
}
