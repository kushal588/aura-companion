import type {
  AudioResult,
  ChatInput,
  ChatProvider,
  SpeechSegment,
  TtsProvider,
} from '../../types/model';
import { EventSequencer } from '../../types/events';
import type { LiveServerEvent, LiveSettings } from '../../types/live';
import type { LiveSession, LiveSessionFactory } from '../../audio/LiveAudioController';
import type { StructuredTurn } from '../../types/turn';
import { createId } from '../../utils/ids';

/**
 * Deterministic offline providers.
 *
 * Used for: the `VITE_AURA_MOCK_PROVIDERS=1` demo mode (so the app is fully
 * explorable without an API key), the automated tests, and the storyboard in
 * PLAN §18. No network access, no cost.
 */

export class MockChatProvider implements ChatProvider {
  private readonly responder: (input: ChatInput) => StructuredTurn;

  constructor(responder?: (input: ChatInput) => StructuredTurn) {
    this.responder = responder ?? defaultResponder;
  }

  async generateTurn(input: ChatInput, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error('aborted');
    // Simulated latency keeps the pending-message UI exercisable.
    await new Promise((resolve) => setTimeout(resolve, 120));
    return JSON.stringify(this.responder(input));
  }
}

export class MockTtsProvider implements TtsProvider {
  static readonly sampleRate = 24000;

  async synthesize(input: SpeechSegment, signal: AbortSignal): Promise<AudioResult> {
    if (signal.aborted) throw new Error('aborted');
    await new Promise((resolve) => setTimeout(resolve, 40));
    return {
      samples: synthesizeSpeechLike(input.text, MockTtsProvider.sampleRate),
      sampleRate: MockTtsProvider.sampleRate,
      mimeType: 'audio/l16;rate=24000',
    };
  }
}

/**
 * Mock Live session: emits a setup acknowledgement, a short spoken reply and a
 * transcript, then completes the turn. Used by live controller tests and by
 * offline demo mode.
 */
export function createMockLiveSessionFactory(): LiveSessionFactory {
  return {
    open(): LiveSession {
      let seq = 0;
      const listeners = new Set<(event: LiveServerEvent) => void>();
      const errorListeners = new Set<(message: string, retryable: boolean) => void>();
      const closeListeners = new Set<(code: number, reason: string) => void>();
      const timers: Array<ReturnType<typeof setTimeout>> = [];

      const emit = (event: LiveServerEvent): void => {
        seq += 1;
        for (const listener of listeners) listener(event);
      };

      const schedule = (delay: number, run: () => void): void => {
        timers.push(setTimeout(run, delay));
      };

      schedule(5, () => emit({ type: 'setup_complete' }));

      return {
        get sequence(): number {
          return seq;
        },
        sendAudio(): void {
          /* the mock ignores microphone input */
        },
        sendText(text: string): void {
          schedule(10, () => emit({ type: 'input_transcript', text, final: true }));
          schedule(30, () => emit({ type: 'output_transcript', text: `You said: ${text}`, final: true }));
          schedule(40, () =>
            emit({
              type: 'audio',
              data: synthesizeSpeechLike(text, MockTtsProvider.sampleRate).buffer as ArrayBuffer,
              sampleRate: MockTtsProvider.sampleRate,
            }),
          );
          schedule(80, () => emit({ type: 'turn_complete' }));
        },
        sendActivity(): void {
          /* automatic VAD in the mock */
        },
        onEvent(listener): () => void {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        onError(listener): () => void {
          errorListeners.add(listener);
          return () => errorListeners.delete(listener);
        },
        onClose(listener): () => void {
          closeListeners.add(listener);
          return () => closeListeners.delete(listener);
        },
        close(): void {
          for (const timer of timers) clearTimeout(timer);
          for (const listener of closeListeners) listener(1000, 'client closed');
        },
      };
    },
  };
}

/**
 * Speech-like waveform: a decaying harmonic stack modulated by syllable-rate
 * amplitude, so lip sync and the audio meter behave realistically.
 */
export function synthesizeSpeechLike(text: string, sampleRate: number): Float32Array {
  const words = text.trim().split(/\s+/).filter(Boolean).length || 1;
  const durationSeconds = Math.min(6, Math.max(0.4, words * 0.32));
  const totalSamples = Math.floor(durationSeconds * sampleRate);
  const samples = new Float32Array(totalSamples);
  const baseFrequency = 130;

  for (let i = 0; i < totalSamples; i += 1) {
    const t = i / sampleRate;
    const syllable = Math.abs(Math.sin(Math.PI * t * 3.4));
    const envelope = Math.min(1, t * 6) * Math.max(0, 1 - t / durationSeconds) * syllable;
    const voiced =
      Math.sin(2 * Math.PI * baseFrequency * t) * 0.5 +
      Math.sin(2 * Math.PI * baseFrequency * 2 * t) * 0.25 +
      Math.sin(2 * Math.PI * baseFrequency * 3 * t) * 0.12;
    samples[i] = voiced * envelope * 0.5;
  }
  return samples;
}

function defaultResponder(input: ChatInput): StructuredTurn {
  const lastUser = [...input.messages].reverse().find((message) => message.role === 'user');
  const text = lastUser?.text ?? '';
  const sequencer = new EventSequencer();
  void sequencer;

  if (/finish|done|complete/i.test(text)) {
    return {
      schemaVersion: 1,
      turnId: createId('turn'),
      segments: [
        {
          id: 's1',
          text: "You finished it? That's fantastic!",
          displayText: "You finished it? That's fantastic!",
          emotion: 'excited',
          intensity: 0.85,
          expression: 'happy',
          gesture: 'celebrate',
          voice: { style: 'bright and energetic', pace: 'normal' },
        },
        {
          id: 's2',
          text: 'What was the hardest part?',
          displayText: 'What was the hardest part?',
          emotion: 'curious',
          intensity: 0.45,
          expression: 'relaxed',
          gesture: 'head_tilt',
          voice: { style: 'gentle and inquisitive', pace: 'normal' },
        },
      ],
      memoryCandidates: [
        {
          content: 'The user finished their project.',
          category: 'project',
          scope: 'character',
          confidence: 0.8,
          importance: 0.7,
        },
      ],
      origin: 'model',
    };
  }

  return {
    schemaVersion: 1,
    turnId: createId('turn'),
    segments: [
      {
        id: 's1',
        text: `This is the offline demo voice. You said: ${text}`,
        displayText: `This is the offline demo voice. You said: ${text}`,
        emotion: 'playful',
        intensity: 0.5,
        expression: 'happy',
        gesture: 'wave',
        voice: { style: 'warm and light', pace: 'normal' },
      },
    ],
    memoryCandidates: [],
    origin: 'model',
  };
}

export const MOCK_LIVE_SETTINGS: LiveSettings = {
  modelId: 'mock-live',
  voiceName: 'Mock',
  systemInstruction: 'Offline demo.',
  inputSampleRate: 16000,
  outputSampleRate: 24000,
  chunkMs: 32,
  maxBufferMs: 1500,
  saveTranscripts: true,
};
