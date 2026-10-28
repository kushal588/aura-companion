import type { ExpressionName } from '../types/emotion';
import { EXPRESSIONS, EMOTION_TO_EXPRESSION, type Emotion } from '../types/emotion';
import { rmsToMouth, DEFAULT_MOUTH_PARAMS, type MouthParams } from '../utils/pcm';

/**
 * Centralised expression + lip-sync writes (PLAN §5.4).
 *
 * Every write to an expression weight goes through here. That is what prevents
 * the classic last-writer-wins flicker where a smile erases the mouth shape the
 * lip sync just wrote: mouth openness is a separate channel and is applied last.
 */

export interface RigExpressionTarget {
  /** Named expression weights the avatar exposes (VRM preset names or the fallback rig). */
  setExpressionWeight(name: string, weight: number): void;
  hasExpression?(name: string): boolean;
  applyBlink?(weight: number): void;
}

export interface ExpressionControllerOptions {
  mouthParams?: MouthParams;
  /** Base weight of the mood expression at full intensity. */
  expressionGain?: number;
  /** Blink cadence bounds in seconds. */
  blinkIntervalRange?: [number, number];
  lookAt?: (yaw: number, pitch: number) => void;
}

export class AvatarExpressionController {
  private target?: RigExpressionTarget;
  private readonly mouthParams: MouthParams;
  private readonly expressionGain: number;
  private readonly blinkRange: [number, number];
  private readonly lookAt?: (yaw: number, pitch: number) => void;

  private emotion: Emotion = 'neutral';
  private intensity = 0;
  private requestedExpression?: ExpressionName;
  private announcedExpression?: ExpressionName;
  private emotionWeight = 0;
  private blinkWeight = 0;
  private nextBlinkAt = 0;
  private blinkStartedAt = 0;
  private mouth = 0;
  private currentMouthTarget = 0;

  constructor(options: ExpressionControllerOptions = {}) {
    this.mouthParams = options.mouthParams ?? DEFAULT_MOUTH_PARAMS;
    this.expressionGain = options.expressionGain ?? 0.85;
    this.blinkRange = options.blinkIntervalRange ?? [2.4, 6.2];
    this.lookAt = options.lookAt;
  }

  attach(target: RigExpressionTarget): void {
    this.target = target;
    this.announcedExpression = undefined;
  }

  setEmotion(emotion: Emotion, intensity: number): void {
    this.emotion = emotion;
    this.intensity = Math.max(0, Math.min(1, intensity));
    this.requestedExpression = EMOTION_TO_EXPRESSION[emotion];
  }

  setExpression(expression: ExpressionName, intensity?: number): void {
    this.requestedExpression = expression;
    if (intensity !== undefined) this.intensity = Math.max(0, Math.min(1, intensity));
  }

  /** Manual preview from the UI: overrides the automatic expression temporarily. */
  previewExpression(expression: ExpressionName): void {
    this.requestedExpression = expression;
    this.intensity = 1;
  }

  /** Feed the live audio level (analyser RMS) to the mouth channel. */
  setAudioLevel(rms: number): void {
    this.currentMouthTarget = rmsToMouth(rms, this.mouth, this.mouthParams);
  }

  /** Feed samples directly (tests, or playback without an analyser). */
  setAudioSamples(samples: Float32Array): void {
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const value = samples[i] as number;
      sum += value * value;
    }
    this.setAudioLevel(Math.sqrt(sum / Math.max(1, samples.length)));
  }

  setSpeaking(speaking: boolean): void {
    if (!speaking) {
      this.currentMouthTarget = 0;
    }
  }

  /** Resolve the expression to use, with a documented fallback order. */
  resolveExpression(): ExpressionName {
    const requested = this.requestedExpression ?? 'neutral';
    const target = this.target;
    if (!target) return requested;
    if (!target.hasExpression || target.hasExpression(requested)) return requested;
    const mapped = EMOTION_TO_EXPRESSION[this.emotion];
    if (target.hasExpression(mapped)) return mapped;
    if (target.hasExpression('neutral')) return 'neutral';
    return EXPRESSIONS[0];
  }

  update(_deltaSeconds: number, now = Date.now()): void {
    if (!this.target) return;
    const expression = this.resolveExpression();

    // Clear the previously announced expression before painting the new one.
    if (this.announcedExpression && this.announcedExpression !== expression) {
      this.target.setExpressionWeight(this.announcedExpression, 0);
    }
    this.announcedExpression = expression;

    const targetWeight = expression === 'neutral' ? this.intensity * 0.25 : this.intensity * this.expressionGain;
    this.emotionWeight += (targetWeight - this.emotionWeight) * 0.18;
    this.target.setExpressionWeight(expression, this.emotionWeight);

    // Blink: randomized interval with a short ramp so it reads as natural.
    if (now >= this.nextBlinkAt && this.blinkStartedAt === 0) {
      this.blinkStartedAt = now;
      const [min, max] = this.blinkRange;
      this.nextBlinkAt = now + (min + Math.random() * (max - min)) * 1000;
    }
    if (this.blinkStartedAt > 0) {
      const elapsed = now - this.blinkStartedAt;
      const duration = 140;
      if (elapsed >= duration) {
        this.blinkWeight = 0;
        this.blinkStartedAt = 0;
      } else {
        this.blinkWeight = Math.sin((elapsed / duration) * Math.PI);
      }
    }
    this.target.applyBlink?.(this.blinkWeight);

    // Mouth is written last so it always wins the frame (PLAN §5.4).
    this.mouth += (this.currentMouthTarget - this.mouth) * 0.35;
    if (!this.target.hasExpression || this.target.hasExpression('aa')) {
      this.target.setExpressionWeight('aa', this.mouth);
    }
  }

  /** Subtle idle gaze movement, driven by the motion controller. */
  applyGaze(yaw: number, pitch: number): void {
    this.lookAt?.(yaw, pitch);
  }

  get mouthOpenness(): number {
    return this.mouth;
  }
}
