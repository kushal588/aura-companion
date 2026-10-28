import { describe, expect, it, vi } from 'vitest';
import { AvatarScheduler, estimateDuration } from '../src/avatar/AvatarScheduler';
import { buildSegmentEvents } from '../src/conversation/EmotionStateMachine';
import type { CharacterEvent } from '../src/types/events';
import type { StructuredTurn } from '../src/types/turn';

function turn(overrides: Partial<StructuredTurn> = {}): StructuredTurn {
  return {
    schemaVersion: 1,
    turnId: 'turn-1',
    origin: 'model',
    memoryCandidates: [],
    segments: [
      {
        id: 's1',
        text: 'You finished it? That is fantastic!',
        displayText: 'You finished it? That is fantastic!',
        emotion: 'excited',
        intensity: 0.85,
        expression: 'happy',
        gesture: 'celebrate',
        voice: { style: 'bright', pace: 'normal' },
      },
      {
        id: 's2',
        text: 'What was the hardest part?',
        displayText: 'What was the hardest part?',
        emotion: 'curious',
        intensity: 0.45,
        expression: 'relaxed',
        gesture: 'head_tilt',
        voice: { style: 'gentle', pace: 'normal' },
      },
    ],
    ...overrides,
  };
}

function makeScheduler(handlers: Record<string, (value: never) => void> = {}) {
  let audioSeconds = 0;
  let now = 1000;
  const scheduler = new AvatarScheduler({
    audioClock: () => audioSeconds,
    now: () => now,
    handlers: {
      onEmotion: handlers['onEmotion'] as never,
      onExpression: handlers['onExpression'] as never,
      onGesture: handlers['onGesture'] as never,
      onSpeaking: handlers['onSpeaking'] as never,
      onEventDropped: handlers['onEventDropped'] as never,
    },
  });
  return {
    scheduler,
    setAudio: (value: number) => {
      audioSeconds = value;
    },
    advanceNow: (value: number) => {
      now = value;
    },
  };
}

describe('AvatarScheduler', () => {
  it('applies the first segment events as soon as its audio position is reached', () => {
    const onGesture = vi.fn();
    const onEmotion = vi.fn();
    const onSpeaking = vi.fn();
    const { scheduler, setAudio } = makeScheduler({ onGesture, onEmotion, onSpeaking });

    scheduler.beginSession('session-1');
    scheduler.scheduleTurn({
      turnId: 'turn-1',
      sessionId: 'session-1',
      turn: turn(),
      startAtAudioSeconds: 0,
      segmentDurations: [1.2, 1.0],
    });

    setAudio(0);
    scheduler.tick(0, 1000);
    expect(onSpeaking).toHaveBeenCalledWith(true);
    expect(onEmotion).toHaveBeenCalledWith('excited', expect.any(Number), 'turn-1');
    expect(onGesture).toHaveBeenCalledWith('celebrate');

    // The second segment only fires once its own offset is reached.
    expect(onGesture).toHaveBeenCalledTimes(1);
    setAudio(1.2);
    scheduler.tick(1.2, 1100);
    expect(onGesture).toHaveBeenCalledWith('head_tilt');
  });

  it('drops events from a superseded session', () => {
    const onGesture = vi.fn();
    const { scheduler, setAudio } = makeScheduler({ onGesture });
    scheduler.beginSession('session-1');
    scheduler.scheduleTurn({
      turnId: 'turn-1',
      sessionId: 'session-1',
      turn: turn(),
      startAtAudioSeconds: 0,
      segmentDurations: [1, 1],
    });
    scheduler.beginSession('session-2');
    expect(scheduler.pendingCount).toBe(0);
    setAudio(0);
    scheduler.tick(0, 1000);
    expect(onGesture).not.toHaveBeenCalled();
  });

  it('drops events for a cancelled turn immediately', () => {
    const onGesture = vi.fn();
    const { scheduler, setAudio } = makeScheduler({ onGesture });
    scheduler.beginSession('session-1');
    scheduler.scheduleTurn({
      turnId: 'turn-1',
      sessionId: 'session-1',
      turn: turn(),
      startAtAudioSeconds: 0,
      segmentDurations: [1, 1],
    });
    scheduler.cancelTurn('turn-1');
    expect(scheduler.pendingCount).toBe(0);
    setAudio(0);
    scheduler.tick(0, 1000);
    expect(onGesture).not.toHaveBeenCalled();
  });

  it('skips events that arrive long after their audio position instead of jerking the face', () => {
    const onGesture = vi.fn();
    const { scheduler, setAudio } = makeScheduler({ onGesture });
    scheduler.beginSession('session-1');
    scheduler.scheduleTurn({
      turnId: 'turn-1',
      sessionId: 'session-1',
      turn: turn(),
      startAtAudioSeconds: 0,
      segmentDurations: [1, 1],
    });
    setAudio(30);
    scheduler.tick(30, 1000);
    expect(scheduler.metrics.lateSkipped).toBeGreaterThan(0);
  });

  it('refuses to apply an untimed gesture that is not safe to apply immediately', () => {
    const onGesture = vi.fn();
    const onDropped = vi.fn();
    const { scheduler } = makeScheduler({ onGesture, onEventDropped: onDropped });
    scheduler.beginSession('session-1');
    const untimed: CharacterEvent = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      seq: 1,
      kind: 'gesture',
      value: 'celebrate',
    };
    (scheduler as unknown as { queue: CharacterEvent[] }).queue.push(untimed);
    scheduler.tick(0, 1000);
    expect(onGesture).not.toHaveBeenCalled();
    expect(onDropped).toHaveBeenCalled();
  });

  it('applies safe untimed events (listening, subtle nod)', () => {
    const onGesture = vi.fn();
    const { scheduler } = makeScheduler({ onGesture });
    scheduler.beginSession('session-1');
    (scheduler as unknown as { queue: CharacterEvent[] }).queue.push({
      sessionId: 'session-1',
      turnId: 'turn-1',
      seq: 1,
      kind: 'gesture',
      value: 'nod',
    });
    scheduler.tick(0, 1000);
    expect(onGesture).toHaveBeenCalledWith('nod');
  });

  it('clears the queue on interrupt and reports not speaking', () => {
    const onSpeaking = vi.fn();
    const { scheduler, setAudio } = makeScheduler({ onSpeaking });
    scheduler.beginSession('session-1');
    scheduler.scheduleTurn({
      turnId: 'turn-1',
      sessionId: 'session-1',
      turn: turn(),
      startAtAudioSeconds: 0,
      segmentDurations: [1, 1],
    });
    setAudio(0);
    scheduler.tick(0, 1000);
    onSpeaking.mockClear();
    scheduler.interrupt();
    expect(scheduler.pendingCount).toBe(0);
    expect(onSpeaking).toHaveBeenCalledWith(false);
  });

  it('ignores out-of-order duplicates within a turn', () => {
    const onEmotion = vi.fn();
    const { scheduler, setAudio } = makeScheduler({ onEmotion });
    scheduler.beginSession('session-1');
    (scheduler as unknown as { queue: CharacterEvent[] }).queue.push(
      { sessionId: 'session-1', turnId: 't', seq: 5, kind: 'emotion', value: 'happy', atAudioSeconds: 0, intensity: 0.5 },
      { sessionId: 'session-1', turnId: 't', seq: 4, kind: 'emotion', value: 'sad', atAudioSeconds: 0, intensity: 0.5 },
    );
    setAudio(0);
    scheduler.tick(0, 1000);
    expect(onEmotion).toHaveBeenCalledTimes(1);
    expect(onEmotion).toHaveBeenCalledWith('happy', expect.any(Number), 't');
  });
});

describe('segment event protocol', () => {
  it('emits speaking, emotion, expression and gesture in order', () => {
    const events = buildSegmentEvents({
      sessionId: 's',
      turnId: 't',
      segmentId: 's1',
      emotion: 'happy',
      intensity: 0.7,
      gesture: 'wave',
      startSeq: 1,
      atAudioSeconds: 0.5,
    });
    expect(events.map((event) => event.kind)).toEqual(['speaking', 'emotion', 'expression', 'gesture', 'speaking']);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events[1]?.value).toBe('happy');
    expect(events[2]?.value).toBe('happy');
    expect(events[3]?.value).toBe('wave');
  });

  it('estimates spoken duration from word count with a sane floor', () => {
    expect(estimateDuration('one two three')).toBeGreaterThan(0.3);
    expect(estimateDuration('')).toBeGreaterThanOrEqual(0.35);
    expect(estimateDuration('one two three four five six seven eight nine ten')).toBeGreaterThan(
      estimateDuration('one two'),
    );
  });
});
