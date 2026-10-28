import type { PlaybackSink } from './LiveAudioController';
import type { AudioResult } from '../types/model';

/**
 * Web Audio playback with a real audio clock and an analyser feed for lip sync
 * (PLAN §7.1 step 9).
 *
 * The audio clock — not wall-clock network timing — drives mouth motion and
 * scheduled events. Chunks are scheduled back-to-back on the AudioContext
 * timeline so a slow network burst cannot desynchronise the face.
 */

export interface PlaybackOptions {
  context?: AudioContext;
  /** Analyser smoothing for the lip-sync signal. */
  smoothingTimeConstant?: number;
  onEnded?: (turnId: string) => void;
}

export interface AudioPlaybackSink extends PlaybackSink {
  readonly context: AudioContext;
  /** Seconds elapsed on the playback timeline since the last reset. */
  readonly clockSeconds: number;
  /** Play one synthesized segment; returns when playback of it finishes. */
  playResult(result: AudioResult, turnId: string): Promise<void>;
  /** Current RMS-amplitude mouth value (0..1) derived from the analyser. */
  currentLevel(): number;
  dispose(): void;
}

class AudioPlaybackSinkImpl implements AudioPlaybackSink {
  readonly context: AudioContext;
  private readonly master: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly analyserData: Float32Array;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private clockStart = 0;
  private scheduledUntil = 0;
  private lastLevel = 0;
  private analyserOk = true;

  constructor(options: PlaybackOptions = {}) {
    this.context = options.context ?? new AudioContext({ latencyHint: 'interactive' });
    this.master = this.context.createGain();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = options.smoothingTimeConstant ?? 0.6;
    this.analyserData = new Float32Array(this.analyser.fftSize);
    this.master.connect(this.analyser);
    this.analyser.connect(this.context.destination);
    this.clockStart = this.context.currentTime;
  }

  get clockSeconds(): number {
    return Math.max(0, this.context.currentTime - this.clockStart);
  }

  private toBuffer(samples: Float32Array, sampleRate: number): AudioBuffer {
    const buffer = this.context.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    return buffer;
  }

  enqueue(samples: Float32Array, sampleRate: number): void {
    const source = this.context.createBufferSource();
    source.buffer = this.toBuffer(samples, sampleRate);
    source.connect(this.master);
    const startAt = Math.max(this.context.currentTime, this.scheduledUntil);
    source.start(startAt);
    this.scheduledUntil = startAt + samples.length / sampleRate;
    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }

  async playResult(result: AudioResult, turnId: string): Promise<void> {
    const durationMs = (result.samples.length / result.sampleRate) * 1000;
    this.enqueue(result.samples, result.sampleRate);
    this.clockStart = Math.min(this.clockStart, this.context.currentTime);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, durationMs);
    });
    this.clockStart = this.context.currentTime;
    this.scheduledUntil = this.context.currentTime;
    void turnId;
  }

  interrupt(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Already stopped sources throw; nothing to do.
      }
    }
    this.sources.clear();
    this.scheduledUntil = this.context.currentTime;
    this.clockStart = this.context.currentTime;
    this.lastLevel = 0;
  }

  bufferedMs(): number {
    const remaining = Math.max(0, this.scheduledUntil - this.context.currentTime);
    return Math.round(remaining * 1000);
  }

  currentLevel(): number {
    if (!this.analyserOk) return this.lastLevel;
    try {
      this.analyser.getFloatTimeDomainData(
        this.analyserData as unknown as Parameters<AnalyserNode['getFloatTimeDomainData']>[0],
      );
    } catch {
      this.analyserOk = false;
      return this.lastLevel;
    }
    let sum = 0;
    for (let i = 0; i < this.analyserData.length; i += 1) {
      const value = this.analyserData[i] as number;
      sum += value * value;
    }
    this.lastLevel = Math.sqrt(sum / this.analyserData.length);
    return this.lastLevel;
  }

  close(): void {
    this.interrupt();
  }

  dispose(): void {
    this.close();
    void this.context.close();
  }
}

export function createAudioPlayback(options: PlaybackOptions = {}): AudioPlaybackSink {
  return new AudioPlaybackSinkImpl(options);
}
