import { rootMeanSquare } from '../utils/pcm';

/**
 * Analyser-based lip sync (PLAN §7.3, v1 stage).
 *
 * Smoothed RMS amplitude with a noise gate and attack/release tuning, exposed as
 * a single mouth-openness value. This is *approximate* lip sync driven by the
 * outgoing audio: it is not phoneme or viseme alignment, and the UI never claims
 * otherwise. Viseme support (v1.1) plugs in behind the same interface.
 */

export interface LipSyncSource {
  /** Latest RMS amplitude (0..1) from the playback analyser. */
  currentLevel(): number;
  bufferedMs(): number;
}

export interface LipSyncOptions {
  gate?: number;
  ceiling?: number;
  attack?: number;
  release?: number;
  /** Extra signal boost for quiet voices. */
  gain?: number;
  /** Mouth value update smoothing. */
  smoothing?: number;
}

export class LipSyncController {
  private readonly options: Required<LipSyncOptions>;
  private source?: LipSyncSource;
  private mouth = 0;
  private lastElevatedAt = 0;
  private speaking = false;

  constructor(options: LipSyncOptions = {}) {
    this.options = {
      gate: options.gate ?? 0.015,
      ceiling: options.ceiling ?? 0.28,
      attack: options.attack ?? 0.5,
      release: options.release ?? 0.16,
      gain: options.gain ?? 1.35,
      smoothing: options.smoothing ?? 0.3,
    };
  }

  attach(source: LipSyncSource): void {
    this.source = source;
  }

  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
    if (!speaking) {
      // Let the jaw close naturally instead of snapping shut.
      this.lastElevatedAt = 0;
    }
  }

  update(now = Date.now()): number {
    const level = this.source ? this.source.currentLevel() * this.options.gain : 0;
    const target = level <= this.options.gate ? 0 : mouthTarget(level, this.options);
    const coefficient = target > this.mouth ? this.options.attack : this.options.release;
    this.mouth += (target - this.mouth) * coefficient;
    if (this.mouth > 0.05) this.lastElevatedAt = now;
    if (!this.speaking && this.mouth < 0.02) this.mouth = 0;
    return this.mouth;
  }

  /** Direct sample feed, used when the audio path has no analyser attached. */
  feedSamples(samples: Float32Array): number {
    const level = rootMeanSquare(samples) * this.options.gain;
    const target = level <= this.options.gate ? 0 : mouthTarget(level, this.options);
    const coefficient = target > this.mouth ? this.options.attack : this.options.release;
    this.mouth += (target - this.mouth) * coefficient;
    return this.mouth;
  }

  get openness(): number {
    return this.mouth;
  }

  get recentlyActive(): boolean {
    return this.lastElevatedAt > 0;
  }

  reset(): void {
    this.mouth = 0;
    this.lastElevatedAt = 0;
    this.speaking = false;
  }
}

function mouthTarget(level: number, options: Required<LipSyncOptions>): number {
  const normalized = (level - options.gate) / Math.max(1e-6, options.ceiling - options.gate);
  return Math.max(0, Math.min(1, normalized)) * 0.95;
}
