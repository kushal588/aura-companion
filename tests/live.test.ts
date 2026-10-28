import { describe, expect, it, vi } from 'vitest';
import {
  LiveAudioController,
  type LiveSession,
  type LiveSessionFactory,
  type MicrophoneSource,
  type PlaybackSink,
} from '../src/audio/LiveAudioController';
import { DEFAULT_LIVE_SETTINGS, type LiveServerEvent, type LiveState, type LiveStatus } from '../src/types/live';
import { buildSetupMessage, encodeAudioChunk, parseLiveMessage, buildLiveSocketUrl } from '../src/providers/gemini/GeminiLiveAdapter';
import { createMockLiveSessionFactory } from '../src/providers/mock/MockProviders';
import { createSilentMicrophone } from '../src/audio/MicrophoneCapture';

function createFakeSession() {
  const eventListeners = new Set<(event: LiveServerEvent) => void>();
  const errorListeners = new Set<(message: string, retryable: boolean) => void>();
  const closeListeners = new Set<(code: number, reason: string) => void>();
  const sent: unknown[] = [];
  const session: LiveSession = {
    sequence: 0,
    sendAudio: vi.fn((pcm: Uint8Array, rate: number) => sent.push({ pcm: pcm.length, rate })),
    sendText: vi.fn((text: string) => sent.push({ text })),
    sendActivity: vi.fn((kind) => sent.push({ activity: kind })),
    onEvent: (listener) => {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onError: (listener) => {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close: vi.fn(),
  };
  return {
    session,
    sent,
    emit: (event: LiveServerEvent) => eventListeners.forEach((listener) => listener(event)),
    emitError: (message: string, retryable: boolean) => errorListeners.forEach((listener) => listener(message, retryable)),
    emitClose: (code: number, reason: string) => closeListeners.forEach((listener) => listener(code, reason)),
  };
}

function createPlayback() {
  const enqueued: number[] = [];
  let interrupted = 0;
  let buffered = 0;
  const sink: PlaybackSink = {
    enqueue: (samples) => enqueued.push(samples.length),
    interrupt: () => {
      interrupted += 1;
      buffered = 0;
    },
    bufferedMs: () => buffered,
    close: () => undefined,
  };
  return {
    sink,
    enqueued,
    interruptedCount: () => interrupted,
    setBuffered: (value: number) => {
      buffered = value;
    },
  };
}

function createMicrophone(): MicrophoneSource {
  const listeners = new Set<(pcm: Uint8Array, rate: number) => void>();
  return {
    start: async () => undefined,
    stop: () => listeners.clear(),
    onChunk: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('LiveAudioController', () => {
  it('moves through requesting_permission → connecting → ready → model_speaking → listening', async () => {
    const states: LiveState[] = [];
    const fake = createFakeSession();
    const playback = createPlayback();
    const factory: LiveSessionFactory = { open: () => fake.session };
    const controller = new LiveAudioController({
      factory,
      settings: DEFAULT_LIVE_SETTINGS,
      microphone: async () => createMicrophone(),
      playback: playback.sink,
      onStatus: (status: LiveStatus) => states.push(status.state),
    });

    await controller.start();
    expect(controller.status.state).toBe('ready');

    fake.emit({ type: 'audio', data: new ArrayBuffer(512), sampleRate: 24000 });
    expect(controller.status.state).toBe('model_speaking');
    expect(playback.enqueued.length).toBe(1);

    fake.emit({ type: 'turn_complete' });
    expect(controller.status.state).toBe('listening');
    expect(states).toContain('requesting_permission');
    expect(states).toContain('connecting');
  });

  it('handles microphone permission denial without opening a session', async () => {
    const opened = vi.fn();
    const controller = new LiveAudioController({
      factory: { open: () => {
        opened();
        return createFakeSession().session;
      } },
      settings: DEFAULT_LIVE_SETTINGS,
      microphone: async () => {
        throw new Error('Permission denied');
      },
      playback: createPlayback().sink,
    });

    await controller.start();
    expect(controller.status.state).toBe('error');
    expect(controller.status.lastError).toMatch(/denied/i);
    expect(opened).not.toHaveBeenCalled();
  });

  it('clears queued speech the moment an interrupt arrives', async () => {
    const fake = createFakeSession();
    const playback = createPlayback();
    const onInterrupt = vi.fn();
    const controller = new LiveAudioController({
      factory: { open: () => fake.session },
      settings: DEFAULT_LIVE_SETTINGS,
      microphone: async () => createMicrophone(),
      playback: playback.sink,
      onInterrupt,
    });

    await controller.start();
    fake.emit({ type: 'audio', data: new ArrayBuffer(256), sampleRate: 24000 });
    fake.emit({ type: 'interrupted' });

    expect(playback.interruptedCount()).toBeGreaterThan(0);
    expect(onInterrupt).toHaveBeenCalled();
    expect(controller.status.state).toBe('listening');
  });

  it('drops audio instead of growing an unbounded buffer', async () => {
    const fake = createFakeSession();
    const playback = createPlayback();
    const controller = new LiveAudioController({
      factory: { open: () => fake.session },
      settings: { ...DEFAULT_LIVE_SETTINGS, maxBufferMs: 500 },
      microphone: async () => createMicrophone(),
      playback: playback.sink,
    });

    await controller.start();
    playback.setBuffered(4000);
    fake.emit({ type: 'audio', data: new ArrayBuffer(512), sampleRate: 24000 });
    fake.emit({ type: 'audio', data: new ArrayBuffer(512), sampleRate: 24000 });

    expect(playback.enqueued).toHaveLength(0);
    expect(controller.status.droppedChunks).toBe(2);
  });

  it('reports disconnection when the socket closes abruptly', async () => {
    const fake = createFakeSession();
    const controller = new LiveAudioController({
      factory: { open: () => fake.session },
      settings: DEFAULT_LIVE_SETTINGS,
      microphone: async () => createMicrophone(),
      playback: createPlayback().sink,
    });
    await controller.start();
    fake.emitClose(1006, 'abnormal closure');
    expect(controller.status.state).toBe('disconnected');
    expect(controller.status.lastError).toMatch(/1006/);
  });

  it('reconnects with a new epoch and ignores frames from the stale socket', async () => {
    const first = createFakeSession();
    const second = createFakeSession();
    const playback = createPlayback();
    let opened = 0;
    const factory: LiveSessionFactory = {
      open: () => {
        opened += 1;
        return opened === 1 ? first.session : second.session;
      },
    };
    const controller = new LiveAudioController({
      factory,
      settings: DEFAULT_LIVE_SETTINGS,
      microphone: async () => createMicrophone(),
      playback: playback.sink,
      maxReconnects: 1,
    });

    await controller.start();
    first.emitError('temporary provider failure', true);
    expect(controller.status.state).toBe('reconnecting');

    await waitFor(() => opened === 2, 2000);
    second.emit({ type: 'setup_complete' });
    await waitFor(() => controller.status.state === 'ready' || controller.status.state === 'listening', 500);

    const before = playback.enqueued.length;
    first.emit({ type: 'audio', data: new ArrayBuffer(256), sampleRate: 24000 });
    expect(playback.enqueued.length).toBe(before);
  });

  it('gives up after the reconnect budget is exhausted', async () => {
    const fake = createFakeSession();
    const controller = new LiveAudioController({
      factory: { open: () => fake.session },
      settings: DEFAULT_LIVE_SETTINGS,
      microphone: async () => createMicrophone(),
      playback: createPlayback().sink,
      maxReconnects: 0,
    });
    await controller.start();
    fake.emit({ type: 'error', message: 'token expired', retryable: true });
    expect(controller.status.state).toBe('error');
    expect(controller.status.lastError).toMatch(/token expired/);
  });

  it('mutes the microphone and tells the provider the turn ended', async () => {
    const fake = createFakeSession();
    const controller = new LiveAudioController({
      factory: { open: () => fake.session },
      settings: DEFAULT_LIVE_SETTINGS,
      microphone: async () => createMicrophone(),
      playback: createPlayback().sink,
    });
    await controller.start();
    controller.setMuted(true);
    expect(controller.status.micMuted).toBe(true);
    expect(fake.sent.some((entry) => JSON.stringify(entry).includes('"activity":"end"'))).toBe(true);
  });

  it('stops cleanly back to idle', async () => {
    const fake = createFakeSession();
    const controller = new LiveAudioController({
      factory: { open: () => fake.session },
      settings: DEFAULT_LIVE_SETTINGS,
      microphone: async () => createMicrophone(),
      playback: createPlayback().sink,
    });
    await controller.start();
    await controller.stop();
    expect(controller.status.state).toBe('idle');
    expect(fake.session.close).toHaveBeenCalled();
  });
});

describe('Live protocol helpers', () => {
  it('builds the setup message exactly as the WebSocket API expects', () => {
    const setup = buildSetupMessage({ ...DEFAULT_LIVE_SETTINGS, modelId: 'gemini-2.5-flash-native-audio-preview-12-2025' });
    const payload = setup as { setup: { model: string; responseModalities: string[]; speechConfig: unknown } };
    expect(payload.setup.model).toBe('models/gemini-2.5-flash-native-audio-preview-12-2025');
    expect(payload.setup.responseModalities).toEqual(['AUDIO']);
    expect(payload.setup.speechConfig).toBeTruthy();
  });

  it('encodes audio chunks as base64 PCM with the mime type the API requires', () => {
    const encoded = JSON.parse(encodeAudioChunk(new Uint8Array([1, 2, 3, 4]), 16000)) as {
      realtimeInput: { audio: { data: string; mimeType: string } };
    };
    expect(encoded.realtimeInput.audio.mimeType).toBe('audio/pcm;rate=16000');
    expect(encoded.realtimeInput.audio.data).toBeTruthy();
  });

  it('selects the ephemeral constrained endpoint and the plain key endpoint', () => {
    expect(buildLiveSocketUrl({ kind: 'apiKey', token: 'KEY' })).toContain('BidiGenerateContent?key=KEY');
    const constrained = buildLiveSocketUrl({ kind: 'ephemeral', token: 'TOKEN' });
    expect(constrained).toContain('BidiGenerateContentConstrained?access_token=TOKEN');
  });

  it('parses server messages into normalised events', () => {
    const audio = parseLiveMessage(
      JSON.stringify({
        serverContent: {
          modelTurn: { parts: [{ inlineData: { data: 'AAAA', mimeType: 'audio/pcm;rate=24000' } }] },
          inputTranscription: { text: 'hi' },
          outputTranscription: { text: 'hello' },
          turnComplete: true,
        },
      }),
    );
    expect(audio.map((event) => event.type)).toEqual([
      'audio',
      'input_transcript',
      'output_transcript',
      'turn_complete',
    ]);
    const interrupted = parseLiveMessage(JSON.stringify({ serverContent: { interrupted: true } }));
    expect(interrupted[0]?.type).toBe('interrupted');
    expect(parseLiveMessage('not json')).toEqual([]);
  });

  it('provides a deterministic offline Live session for demo mode', async () => {
    const controller = new LiveAudioController({
      factory: createMockLiveSessionFactory(),
      settings: { ...DEFAULT_LIVE_SETTINGS, modelId: 'mock' },
      microphone: async () => createSilentMicrophone(),
      playback: createPlayback().sink,
    });
    await controller.start();
    await waitFor(() => controller.status.state === 'ready');
    controller.sendText('hello mock');
    await waitFor(() => controller.status.state === 'listening' || controller.status.state === 'model_speaking');
    await controller.stop();
    expect(controller.status.state).toBe('idle');
  });
});
