import { EventSequencer, type CharacterEvent } from '../types/events';
import type { Emotion, ExpressionName, Gesture } from '../types/emotion';
import { isEmotion, isExpression, isGesture } from '../types/emotion';
import { SAFE_IMMEDIATE_GESTURES } from '../types/emotion';
import { EmotionStateMachine, buildSegmentEvents } from '../conversation/EmotionStateMachine';
import type { StructuredTurn } from '../types/turn';

export interface SchedulerHandlers {
  onEmotion?: (emotion: Emotion, intensity: number, sourceTurnId: string) => void;
  onExpression?: (expression: ExpressionName, intensity: number) => void;
  onGesture?: (gesture: Gesture) => void;
  onSpeaking?: (speaking: boolean) => void;
  onEventApplied?: (event: CharacterEvent) => void;
  onEventDropped?: (event: CharacterEvent, reason: string) => void;
}

export interface SchedulerOptions {
  handlers?: SchedulerHandlers;
  /** Clock used for scheduling; must be the playback clock (PLAN §7.1 step 8). */
  audioClock: () => number;
  now?: () => number;
  emotion?: EmotionStateMachine;
  /** Events without a timestamp further than this in the future are dropped. */
  maxLookaheadSeconds?: number;
}

/**
 * Avatar event scheduler (PLAN §5.2, §10.2).
 *
 * Single owner of "when does the character do what". Guarantees:
 *  - events from a superseded session or cancelled turn are dropped, never applied;
 *  - events are ordered by sequence number within a turn;
 *  - events are applied against the audio clock, so a stalled network cannot
 *    produce a wildly mistimed reaction;
 *  - on interruption the queue is cleared synchronously.
 */
export class AvatarScheduler {
  private readonly options: SchedulerOptions;
  private readonly handlers: SchedulerHandlers;
  private readonly sequencerByTurn = new Map<string, EventSequencer>();
  private queue: CharacterEvent[] = [];
  private sessionId = '';
  private activeTurnId?: string;
  private cancelledTurns = new Set<string>();
  private lastAppliedSeq = new Map<string, number>();
  private speaking = false;

  readonly mood: EmotionStateMachine;
  readonly metrics = { applied: 0, dropped: 0, lateSkipped: 0 };

  constructor(options: SchedulerOptions) {
    this.options = options;
    this.handlers = options.handlers ?? {};
    this.mood = options.emotion ?? new EmotionStateMachine();
  }

  /** Start a new session; everything queued for the old session is discarded. */
  beginSession(sessionId: string): void {
    this.sessionId = sessionId;
    this.queue = [];
    this.lastAppliedSeq.clear();
    this.activeTurnId = undefined;
    this.mood.reset(this.now());
  }

  /** Schedule validated segments of one turn against the playback clock. */
  scheduleTurn(params: {
    turnId: string;
    sessionId: string;
    turn: StructuredTurn;
    /** Playback offset where this turn's audio starts, in seconds. */
    startAtAudioSeconds: number;
    /** Estimated spoken duration per segment, in seconds. */
    segmentDurations: number[];
  }): CharacterEvent[] {
    this.cancelledTurns.delete(params.turnId);
    this.activeTurnId = params.turnId;
    const sequencer = new EventSequencer();
    this.sequencerByTurn.set(params.turnId, sequencer);

    const events: CharacterEvent[] = [];
    let offset = params.startAtAudioSeconds;
    params.turn.segments.forEach((segment, index) => {
      const duration = params.segmentDurations[index] ?? estimateDuration(segment.text);
      const segmentEvents = buildSegmentEvents({
        sessionId: params.sessionId,
        turnId: params.turnId,
        segmentId: segment.id,
        emotion: segment.emotion,
        intensity: segment.intensity,
        gesture: segment.gesture,
        startSeq: sequencer.current,
        atAudioSeconds: offset,
        durationSeconds: duration,
      });
      for (const event of segmentEvents) {
        sequencer.next();
        events.push(event);
      }
      offset += duration;
    });

    this.queue.push(...events);
    this.queue.sort((a, b) => (a.atAudioSeconds ?? 0) - (b.atAudioSeconds ?? 0) || a.seq - b.seq);
    return events;
  }

  /** Apply everything that is due at the current playback time. */
  tick(audioSeconds = this.options.audioClock(), now = this.now()): void {
    const lookahead = this.options.maxLookaheadSeconds ?? 2;
    const remaining: CharacterEvent[] = [];

    for (const event of this.queue) {
      if (event.sessionId !== this.sessionId) {
        this.drop(event, 'stale session');
        continue;
      }
      if (this.cancelledTurns.has(event.turnId)) {
        this.drop(event, 'cancelled turn');
        continue;
      }
      const at = event.atAudioSeconds;
      if (at === undefined) {
        // Untimed events may only be applied when they are safe.
        if (event.kind === 'gesture' && !SAFE_IMMEDIATE_GESTURES.includes(event.value as Gesture)) {
          this.drop(event, 'untimed unsafe gesture');
          continue;
        }
        this.apply(event, now);
        continue;
      }
      if (at > audioSeconds + lookahead) {
        remaining.push(event);
        continue;
      }
      if (at > audioSeconds) {
        remaining.push(event);
        continue;
      }
      if (audioSeconds - at > lookahead) {
        // Arrived too late to be believable — skip instead of jerking the face.
        this.metrics.lateSkipped += 1;
        this.drop(event, 'late');
        continue;
      }
      const lastSeq = this.lastAppliedSeq.get(event.turnId) ?? -1;
      if (event.seq <= lastSeq) {
        this.drop(event, 'out of order');
        continue;
      }
      this.apply(event, now);
    }

    this.queue = remaining;
    this.mood.tick(now, 1 / 30);
  }

  private apply(event: CharacterEvent, now: number): void {
    this.lastAppliedSeq.set(event.turnId, event.seq);
    this.metrics.applied += 1;

    switch (event.kind) {
      case 'emotion': {
        if (!isEmotion(event.value)) {
          this.drop(event, 'unknown emotion');
          return;
        }
        const mood = this.mood.apply({
          emotion: event.value,
          intensity: event.intensity ?? 0.4,
          turnId: event.turnId,
          now,
        });
        this.handlers.onEmotion?.(mood.emotion, mood.intensity, event.turnId);
        return;
      }
      case 'expression': {
        if (!isExpression(event.value)) {
          this.drop(event, 'unknown expression');
          return;
        }
        this.handlers.onExpression?.(event.value, event.intensity ?? 0.5);
        return;
      }
      case 'gesture': {
        if (!isGesture(event.value)) {
          this.drop(event, 'unknown gesture');
          return;
        }
        if (!this.mood.allowGesture(event.value, now)) {
          this.drop(event, 'gesture cooldown');
          return;
        }
        this.handlers.onGesture?.(event.value);
        return;
      }
      case 'speaking': {
        const speaking = event.value === 'start';
        if (this.speaking !== speaking) {
          this.speaking = speaking;
          this.handlers.onSpeaking?.(speaking);
        }
        return;
      }
      case 'interrupt': {
        this.interrupt();
        return;
      }
      case 'listening': {
        this.handlers.onSpeaking?.(false);
        return;
      }
      default:
        return;
    }
  }

  private drop(event: CharacterEvent, reason: string): void {
    this.metrics.dropped += 1;
    this.handlers.onEventDropped?.(event, reason);
  }

  /** Cancel a turn and clear its queued events immediately. */
  cancelTurn(turnId: string): void {
    this.cancelledTurns.add(turnId);
    this.queue = this.queue.filter((event) => event.turnId !== turnId);
    this.mood.reset(this.now());
    this.speaking = false;
  }

  /** Full interrupt: drop everything queued (PLAN §8.3). */
  interrupt(): void {
    for (const event of this.queue) {
      this.drop(event, 'interrupted');
    }
    this.queue = [];
    this.speaking = false;
    this.handlers.onSpeaking?.(false);
    this.mood.reset(this.now());
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  /** Turn currently being played, if any — used by diagnostics and by tests. */
  get activeTurn(): string | undefined {
    return this.activeTurnId;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** Words per minute heuristic used to place segment events before audio exists. */
export function estimateDuration(text: string, wordsPerMinute = 165): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(0.35, (words / wordsPerMinute) * 60);
}
