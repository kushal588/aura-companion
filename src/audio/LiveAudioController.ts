import type { LiveServerEvent, LiveSettings, LiveState, LiveStatus } from '../types/live';

/**
 * Live conversation controller (PLAN §8).
 *
 * The controller owns the state machine, the sequence/epoch bookkeeping and the
 * playback jitter buffer. It is deliberately transport-agnostic: the Gemini
 * WebSocket adapter, the offline mock and the tests all implement `LiveSession`.
 */

export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
}

export interface LiveSession {
  /** Monotonic counter of received server messages, used for stale detection. */
  readonly sequence: number;
  sendAudio(pcm16: Uint8Array, sampleRate: number): void;
  sendText(text: string): void;
  sendActivity(kind: 'start' | 'end'): void;
  onEvent(listener: (event: LiveServerEvent) => void): () => void;
  onError(listener: (message: string, retryable: boolean) => void): () => void;
  onClose(listener: (code: number, reason: string) => void): () => void;
  close(): void;
}

export interface LiveSessionFactory {
  open(): LiveSession;
}

/** Microphone abstraction so tests never need a real device. */
export interface MicrophoneSource {
  start(): Promise<void>;
  stop(): void;
  onChunk(listener: (pcm16: Uint8Array, sampleRate: number) => void): () => void;
}

/** Playback abstraction; the real one is Web Audio, tests use a fake. */
export interface PlaybackSink {
  enqueue(samples: Float32Array, sampleRate: number): void;
  interrupt(): void;
  bufferedMs(): number;
  close(): void;
}

export interface LiveControllerOptions {
  factory: LiveSessionFactory;
  settings: LiveSettings;
  microphone: () => Promise<MicrophoneSource>;
  playback: PlaybackSink;
  /** Injected clock for deterministic tests. */
  now?: () => number;
  /** Reconnect attempts before giving up. */
  maxReconnects?: number;
  onStatus?: (status: LiveStatus) => void;
  onTranscript?: (transcript: { role: 'user' | 'assistant'; text: string; final: boolean }) => void;
  onInterrupt?: () => void;
  /** Called when the provider asks us to go away; the app may reopen. */
  onGoAway?: (timeLeftMs?: number) => void;
}

export class LiveAudioController {
  private readonly options: LiveControllerOptions;
  private readonly settings: LiveSettings;
  private session?: LiveSession;
  private microphone?: MicrophoneSource;
  private detachEvents?: () => void;
  private detachError?: () => void;
  private detachClose?: () => void;
  private detachChunk?: () => void;

  private state: LiveState = 'idle';
  private epoch = 0;
  private startedAt?: number;
  private muted = false;
  private reconnects = 0;
  private droppedChunks = 0;
  private lastError?: string;
  /** Buffer cap enforcement: oldest audio is dropped, never accumulated. */
  private pendingAudioBytes = 0;

  constructor(options: LiveControllerOptions) {
    this.options = options;
    this.settings = options.settings;
  }

  get status(): LiveStatus {
    return {
      state: this.state,
      epoch: this.epoch,
      startedAt: this.startedAt,
      lastError: this.lastError,
      micMuted: this.muted,
      bufferedMs: this.options.playback.bufferedMs(),
      droppedChunks: this.droppedChunks,
    };
  }

  private setState(state: LiveState, error?: string): void {
    this.state = state;
    if (error) this.lastError = error;
    this.options.onStatus?.(this.status);
  }

  async start(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'disconnected' && this.state !== 'error') return;
    this.epoch += 1;
    this.reconnects = 0;
    await this.connect();
  }

  private async connect(): Promise<void> {
    this.setState('requesting_permission');
    try {
      this.microphone = await this.options.microphone();
      await this.microphone.start();
    } catch (error) {
      this.setState(
        'error',
        error instanceof Error && /denied|permission/i.test(error.message)
          ? 'Microphone permission was denied. Live mode needs it; nothing is recorded without it.'
          : `The microphone could not be started (${error instanceof Error ? error.message : String(error)}).`,
      );
      return;
    }

    this.setState('connecting');
    const epoch = this.epoch;
    const session = this.options.factory.open();
    this.session = session;

    this.detachEvents = session.onEvent((event) => this.handleEvent(epoch, event));
    this.detachError = session.onError((message, retryable) => {
      if (epoch !== this.epoch) return;
      this.setState(retryable ? 'reconnecting' : 'error', message);
      if (retryable) this.scheduleReconnect(message);
    });
    this.detachClose = session.onClose((code, reason) => {
      if (epoch !== this.epoch) return;
      this.setState('disconnected', `Live session closed (${code}${reason ? `: ${reason}` : ''}).`);
    });

    this.detachChunk = this.microphone.onChunk((pcm16, sampleRate) => {
      if (this.muted || epoch !== this.epoch) return;
      const session2 = this.session;
      if (!session2) return;
      if (this.pendingAudioBytes > this.settings.inputSampleRate * 2 * 2) {
        // Backpressure guard: never queue unlimited microphone audio.
        this.droppedChunks += 1;
        return;
      }
      this.pendingAudioBytes += pcm16.byteLength;
      session2.sendAudio(pcm16, sampleRate);
      this.pendingAudioBytes = Math.max(0, this.pendingAudioBytes - pcm16.byteLength);
      if (this.state === 'ready') {
        this.setState('user_speaking');
      }
    });

    this.startedAt = this.options.now?.() ?? Date.now();
    this.setState('ready');
  }

  private scheduleReconnect(reason: string): void {
    const maxReconnects = this.options.maxReconnects ?? 3;
    if (this.reconnects >= maxReconnects) {
      this.setState('error', `${reason} Reconnection gave up after ${this.reconnects} attempts.`);
      return;
    }
    this.reconnects += 1;
    const delay = Math.min(4000, 400 * 2 ** (this.reconnects - 1));
    setTimeout(() => {
      if (this.state !== 'reconnecting') return;
      this.teardownSession();
      // A fresh epoch invalidates every in-flight chunk from the old socket.
      this.epoch += 1;
      this.state = 'disconnected';
      void this.connect();
    }, delay);
  }

  private handleEvent(epoch: number, event: LiveServerEvent): void {
    if (epoch !== this.epoch) return;

    switch (event.type) {
      case 'setup_complete':
        this.setState('ready');
        return;
      case 'audio': {
        const samples = toFloat32(event.data);
        const buffered = this.options.playback.bufferedMs();
        if (buffered > this.settings.maxBufferMs) {
          this.droppedChunks += 1;
          return;
        }
        this.options.playback.enqueue(samples, event.sampleRate);
        if (this.state !== 'model_speaking' && this.state !== 'interrupted') {
          this.setState('model_speaking');
        }
        return;
      }
      case 'input_transcript':
        this.options.onTranscript?.({ role: 'user', text: event.text, final: event.final });
        if (this.state === 'ready' || this.state === 'user_speaking') {
          this.setState('user_speaking');
        }
        return;
      case 'output_transcript':
        this.options.onTranscript?.({ role: 'assistant', text: event.text, final: event.final });
        return;
      case 'interrupted':
        this.handleInterrupt();
        return;
      case 'turn_complete':
      case 'generation_complete':
        if (this.state !== 'disconnected' && this.state !== 'error') {
          this.setState('listening');
        }
        return;
      case 'go_away':
        this.options.onGoAway?.(event.timeLeftMs);
        this.setState('reconnecting', 'The session is ending; reconnecting.');
        this.scheduleReconnect('The provider ended the session.');
        return;
      case 'tool_call':
        // The app exposes no LLM tools; acknowledge nothing and stay silent.
        return;
      case 'error':
        this.setState(event.retryable ? 'reconnecting' : 'error', event.message);
        if (event.retryable) this.scheduleReconnect(event.message);
        return;
      default:
        return;
    }
  }

  /** Interruption must drop queued speech immediately (PLAN §8.3, §14.3). */
  private handleInterrupt(): void {
    this.options.playback.interrupt();
    this.setState('interrupted');
    this.options.onInterrupt?.();
    this.setState('listening');
  }

  /** Local interrupt — used by the Stop button and by text input while speaking. */
  interrupt(): void {
    this.handleInterrupt();
  }

  sendText(text: string): void {
    this.session?.sendText(text);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.session?.sendActivity('end');
      this.options.playback.interrupt();
    }
    this.options.onStatus?.(this.status);
  }

  async stop(): Promise<void> {
    this.epoch += 1;
    this.setState('disconnected');
    this.teardownSession();
    this.microphone?.stop();
    this.microphone = undefined;
    this.options.playback.interrupt();
    this.setState('idle');
  }

  private teardownSession(): void {
    this.detachEvents?.();
    this.detachError?.();
    this.detachClose?.();
    this.detachChunk?.();
    this.detachEvents = undefined;
    this.detachError = undefined;
    this.detachClose = undefined;
    this.detachChunk = undefined;
    this.session?.close();
    this.session = undefined;
  }
}

function toFloat32(buffer: ArrayBuffer): Float32Array {
  const sampleCount = Math.floor(buffer.byteLength / 2);
  const view = new DataView(buffer);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }
  return samples;
}
