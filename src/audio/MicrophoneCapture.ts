import type { MicrophoneSource } from './LiveAudioController';
import { float32ToPcm16, resampleLinear } from '../utils/pcm';

/**
 * Microphone capture (PLAN §8.3).
 *
 * Permission is requested only when Live mode starts. Audio is resampled to the
 * provider's rate (16 kHz) and emitted as small 16-bit PCM chunks (20–40 ms) so
 * latency stays low. Nothing is ever recorded to disk.
 */

export interface MicrophoneOptions {
  targetSampleRate?: number;
  chunkMs?: number;
  /** Echo cancellation and noise suppression where the platform supports it. */
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  /** Constrain the capture so the app's own speaker output is not re-captured. */
  deviceId?: string;
}

export interface MicrophoneCapture extends MicrophoneSource {
  readonly active: boolean;
  readonly sampleRate: number;
}

export class BrowserMicrophoneCapture implements MicrophoneCapture {
  private readonly options: Required<Omit<MicrophoneOptions, 'deviceId'>> & { deviceId?: string };
  private stream?: MediaStream;
  private context?: AudioContext;
  private sourceNode?: MediaStreamAudioSourceNode;
  private processor?: ScriptProcessorNode;
  private workletNode?: AudioWorkletNode;
  private listeners = new Set<(pcm16: Uint8Array, sampleRate: number) => void>();
  private remainder = new Float32Array(0);
  private activeFlag = false;

  constructor(options: MicrophoneOptions = {}) {
    this.options = {
      targetSampleRate: options.targetSampleRate ?? 16000,
      chunkMs: options.chunkMs ?? 32,
      echoCancellation: options.echoCancellation ?? true,
      noiseSuppression: options.noiseSuppression ?? true,
      autoGainControl: options.autoGainControl ?? true,
      deviceId: options.deviceId,
    };
  }

  get active(): boolean {
    return this.activeFlag;
  }

  get sampleRate(): number {
    return this.options.targetSampleRate;
  }

  async start(): Promise<void> {
    if (this.activeFlag) return;
    if (!navigator?.mediaDevices?.getUserMedia) {
      throw new Error('Microphone capture is unavailable in this environment.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: this.options.echoCancellation,
        noiseSuppression: this.options.noiseSuppression,
        autoGainControl: this.options.autoGainControl,
        ...(this.options.deviceId ? { deviceId: { exact: this.options.deviceId } } : {}),
      },
      video: false,
    });

    this.context = new AudioContext();
    this.sourceNode = this.context.createMediaStreamSource(this.stream);

    const workletReady = await this.tryWorklet();
    if (!workletReady) {
      this.setupScriptProcessor();
    }
    this.activeFlag = true;
  }

  /**
   * Preferred path: an AudioWorklet so capture runs off the main thread. The
   * module is inlined as a blob so the app stays a single deployable bundle.
   */
  private async tryWorklet(): Promise<boolean> {
    const context = this.context;
    if (!context?.audioWorklet || typeof URL?.createObjectURL !== 'function') return false;
    try {
      const code = `
        class AuraCapture extends AudioWorkletProcessor {
          process(inputs) {
            const input = inputs[0];
            if (input && input[0]) {
              this.port.postMessage(input[0].slice(0));
            }
            return true;
          }
        }
        registerProcessor('aura-capture', AuraCapture);
      `;
      const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      await context.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(context, 'aura-capture');
      node.port.onmessage = (event: MessageEvent) => {
        const samples = event.data as Float32Array;
        this.handleSamples(samples, context.sampleRate);
      };
      this.sourceNode?.connect(node);
      const silent = context.createGain();
      silent.gain.value = 0;
      node.connect(silent);
      silent.connect(context.destination);
      this.workletNode = node;
      return true;
    } catch {
      return false;
    }
  }

  /** Fallback for WebViews without AudioWorklet (deprecated but universal). */
  private setupScriptProcessor(): void {
    const context = this.context;
    if (!context || !this.sourceNode) return;
    const processor = context.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      const samples = new Float32Array(event.inputBuffer.getChannelData(0));
      this.handleSamples(samples, context.sampleRate);
    };
    this.sourceNode.connect(processor);
    const silent = context.createGain();
    silent.gain.value = 0;
    processor.connect(silent);
    silent.connect(context.destination);
    this.processor = processor;
  }

  private handleSamples(samples: Float32Array, inputRate: number): void {
    // Never capture the app's own speaker output.
    const resampled = resampleLinear(samples, inputRate, this.options.targetSampleRate);
    const merged = new Float32Array(this.remainder.length + resampled.length);
    merged.set(this.remainder, 0);
    merged.set(resampled, this.remainder.length);

    const chunkSize = Math.max(
      1,
      Math.floor((this.options.targetSampleRate * this.options.chunkMs) / 1000),
    );
    let offset = 0;
    while (merged.length - offset >= chunkSize) {
      const chunk = merged.slice(offset, offset + chunkSize);
      const pcm16 = float32ToPcm16(chunk);
      for (const listener of this.listeners) listener(pcm16, this.options.targetSampleRate);
      offset += chunkSize;
    }
    this.remainder = merged.slice(offset);
  }

  onChunk(listener: (pcm16: Uint8Array, sampleRate: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stop(): void {
    this.activeFlag = false;
    this.listeners.clear();
    this.remainder = new Float32Array(0);
    this.workletNode?.disconnect();
    this.workletNode = undefined;
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor.disconnect();
      this.processor = undefined;
    }
    this.sourceNode?.disconnect();
    this.sourceNode = undefined;
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop();
    }
    this.stream = undefined;
    void this.context?.close();
    this.context = undefined;
  }
}

/** Injected by tests and offline mode. */
export function createSilentMicrophone(): MicrophoneCapture {
  const listeners = new Set<(pcm16: Uint8Array, sampleRate: number) => void>();
  let active = false;
  return {
    get active() {
      return active;
    },
    sampleRate: 16000,
    async start() {
      active = true;
    },
    stop() {
      active = false;
      listeners.clear();
    },
    onChunk(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
