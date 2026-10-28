import type { Emotion, Gesture } from './emotion';

export const AVATAR_EVENT_KINDS = [
  'emotion',
  'expression',
  'gesture',
  'speaking',
  'listening',
  'interrupt',
] as const;
export type AvatarEventKind = (typeof AVATAR_EVENT_KINDS)[number];

/**
 * One scheduled animation instruction (PLAN §10.2).
 *
 * `sessionId` and `turnId` make stale events detectable: the avatar scheduler
 * drops anything belonging to a superseded session or cancelled turn, so a late
 * network reply can never animate a conversation that is already over.
 */
export interface CharacterEvent {
  sessionId: string;
  turnId: string;
  segmentId?: string;
  seq: number;
  /**
   * Audio-clock offset in seconds. When present the event is applied when the
   * playback clock reaches this point — never on wall-clock network timing.
   * When absent only safe immediate events may be applied.
   */
  atAudioSeconds?: number;
  kind: AvatarEventKind;
  value: string;
  intensity?: number;
}

/** Alias used by the conversation layer, which speaks in terms of avatar events. */
export type AvatarEvent = CharacterEvent;

/** Convenience constructors keep `seq` monotonic per scheduled turn. */
export class EventSequencer {
  private seq = 0;

  next(): number {
    this.seq += 1;
    return this.seq;
  }

  get current(): number {
    return this.seq;
  }

  reset(): void {
    this.seq = 0;
  }
}

export function emotionEvent(params: {
  sessionId: string;
  turnId: string;
  segmentId?: string;
  seq: number;
  emotion: Emotion;
  intensity: number;
  atAudioSeconds?: number;
}): CharacterEvent {
  return {
    sessionId: params.sessionId,
    turnId: params.turnId,
    segmentId: params.segmentId,
    seq: params.seq,
    kind: 'emotion',
    value: params.emotion,
    intensity: params.intensity,
    atAudioSeconds: params.atAudioSeconds,
  };
}

export function gestureEvent(params: {
  sessionId: string;
  turnId: string;
  segmentId?: string;
  seq: number;
  gesture: Gesture;
  atAudioSeconds?: number;
}): CharacterEvent {
  return {
    sessionId: params.sessionId,
    turnId: params.turnId,
    segmentId: params.segmentId,
    seq: params.seq,
    kind: 'gesture',
    value: params.gesture,
    atAudioSeconds: params.atAudioSeconds,
  };
}
