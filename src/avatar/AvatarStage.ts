import {
  AmbientLight,
  Clock,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  MathUtils,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { AvatarRig } from './types';

/**
 * Avatar stage: renderer, scene, camera, lights and quality tiers (PLAN §5.2, §5.5).
 *
 * Quality is a target, not a guarantee: the stage measures real frame time and
 * downgrades itself when the device cannot keep up, and rendering pauses while
 * the window is hidden. The renderer is disposed completely on teardown so
 * switching avatars cannot leak GPU memory.
 */

export type QualityTier = 'low' | 'balanced' | 'high';

export interface StageQualitySettings {
  pixelRatio: number;
  shadows: boolean;
  targetFps: number;
  fog: boolean;
}

export const QUALITY_PRESETS: Record<QualityTier, StageQualitySettings> = {
  low: { pixelRatio: 0.75, shadows: false, targetFps: 30, fog: false },
  balanced: { pixelRatio: 1, shadows: false, targetFps: 60, fog: true },
  high: { pixelRatio: Math.min(2, 2), shadows: true, targetFps: 60, fog: true },
};

export interface AvatarStageOptions {
  canvas: HTMLCanvasElement;
  quality?: QualityTier;
  backgroundColor?: number;
  /** Called once per frame after the rig updates. */
  onFrame?: (info: { deltaSeconds: number; elapsedSeconds: number; fps: number }) => void;
  onQualityChange?: (tier: QualityTier, reason: string) => void;
}

export class AvatarStage {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  private readonly renderer: WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly clock = new Clock();
  private readonly options: AvatarStageOptions;
  private rig?: AvatarRig;
  private quality: QualityTier;
  private frameHandle = 0;
  private running = false;
  private fpsSamples: number[] = [];
  private lastFpsReport = 0;
  private adaptiveDisabled = false;

  // Orbit camera state
  private readonly target = new Vector3(0, 1.15, 0);
  private yaw = 0;
  private pitch = 0.06;
  private distance = 2.4;
  private dragging = false;
  private lastPointer = { x: 0, y: 0 };
  private pinchDistance = 0;
  private readonly disposers: Array<() => void> = [];

  constructor(options: AvatarStageOptions) {
    this.options = options;
    this.canvas = options.canvas;
    this.quality = options.quality ?? 'balanced';

    this.renderer = new WebGLRenderer({
      canvas: options.canvas,
      antialias: this.quality !== 'low',
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.setClearColor(new Color(options.backgroundColor ?? 0x11151c), 1);

    this.camera = new PerspectiveCamera(32, 1, 0.1, 40);
    this.scene.add(new AmbientLight(0xffffff, 0.55));
    this.scene.add(new HemisphereLight(0xcfe8ff, 0x28313f, 0.7));
    const key = new DirectionalLight(0xfff3e0, 1.1);
    key.position.set(1.4, 2.2, 1.8);
    key.castShadow = false;
    this.scene.add(key);
    const rim = new DirectionalLight(0x9ec9ff, 0.35);
    rim.position.set(-1.6, 1.2, -1.4);
    this.scene.add(rim);
    this.scene.fog = new Fog(0x11151c, 4.5, 12);

    this.applyQuality(this.quality, 'initial');
    this.attachInput();
    this.handleResize();

    const onResize = (): void => this.handleResize();
    globalThis.addEventListener?.('resize', onResize);
    this.disposers.push(() => globalThis.removeEventListener?.('resize', onResize));

    const onVisibility = (): void => {
      if (document.hidden) {
        this.pause();
      } else if (!this.adaptiveDisabled) {
        this.resume();
      }
    };
    document.addEventListener?.('visibilitychange', onVisibility);
    this.disposers.push(() => document.removeEventListener?.('visibilitychange', onVisibility));
  }

  get currentQuality(): QualityTier {
    return this.quality;
  }

  attachRig(rig: AvatarRig): void {
    if (this.rig) {
      this.scene.remove(this.rig.root);
      this.rig.dispose();
    }
    this.rig = rig;
    this.scene.add(rig.root);
  }

  setQuality(tier: QualityTier, reason = 'user'): void {
    this.applyQuality(tier, reason);
  }

  /** Disable the automatic downgrade (used by the benchmark/diagnostics panel). */
  setAdaptive(enabled: boolean): void {
    this.adaptiveDisabled = !enabled;
  }

  private applyQuality(tier: QualityTier, reason: string): void {
    const preset = QUALITY_PRESETS[tier];
    this.quality = tier;
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, preset.pixelRatio));
    this.renderer.shadowMap.enabled = preset.shadows;
    this.scene.fog = preset.fog ? this.scene.fog ?? new Fog(0x11151c, 4.5, 12) : null;
    this.options.onQualityChange?.(tier, reason);
  }

  private attachInput(): void {
    const canvas = this.canvas;

    const onPointerDown = (event: PointerEvent): void => {
      this.dragging = true;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!this.dragging) return;
      const dx = event.clientX - this.lastPointer.x;
      const dy = event.clientY - this.lastPointer.y;
      this.lastPointer = { x: event.clientX, y: event.clientY };
      this.yaw -= dx * 0.005;
      this.pitch = MathUtils.clamp(this.pitch - dy * 0.004, -0.5, 0.85);
    };
    const onPointerUp = (event: PointerEvent): void => {
      this.dragging = false;
      canvas.releasePointerCapture?.(event.pointerId);
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      this.distance = MathUtils.clamp(this.distance + event.deltaY * 0.0016, 0.9, 6);
    };
    const onDoubleClick = (): void => this.resetView();
    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length === 2) {
        this.pinchDistance = touchDistance(event);
      }
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (event.touches.length !== 2) return;
      const distance = touchDistance(event);
      if (this.pinchDistance > 0) {
        this.distance = MathUtils.clamp(this.distance * (this.pinchDistance / distance), 0.9, 6);
      }
      this.pinchDistance = distance;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDoubleClick);
    canvas.addEventListener('touchstart', onTouchStart, { passive: true });
    canvas.addEventListener('touchmove', onTouchMove, { passive: true });

    this.disposers.push(() => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
    });
  }

  resetView(): void {
    this.yaw = 0;
    this.pitch = 0.06;
    this.distance = 2.4;
  }

  frameAvatarOnce(): void {
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const loop = (): void => {
      if (!this.running) return;
      this.frameHandle = requestAnimationFrame(loop);
      const delta = Math.min(0.1, this.clock.getDelta());
      const elapsed = this.clock.elapsedTime;
      this.rig?.update(delta);
      this.updateCamera();
      this.renderer.render(this.scene, this.camera);
      this.trackPerformance(delta);
      this.options.onFrame?.({ deltaSeconds: delta, elapsedSeconds: elapsed, fps: this.currentFps });
    };
    this.frameHandle = requestAnimationFrame(loop);
  }

  pause(): void {
    this.running = false;
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
  }

  resume(): void {
    if (this.running) return;
    this.start();
  }

  private currentFps = 0;

  private trackPerformance(delta: number): void {
    if (delta <= 0) return;
    this.fpsSamples.push(1 / delta);
    if (this.fpsSamples.length > 90) this.fpsSamples.shift();
    const now = performance.now?.() ?? Date.now();
    if (now - this.lastFpsReport < 1500) return;
    this.lastFpsReport = now;
    const average = this.fpsSamples.reduce((sum, value) => sum + value, 0) / this.fpsSamples.length;
    this.currentFps = Math.round(average);

    if (this.adaptiveDisabled) return;
    const preset = QUALITY_PRESETS[this.quality];
    if (average < preset.targetFps * 0.6) {
      if (this.quality === 'high') {
        this.applyQuality('balanced', `dropped to balanced (${Math.round(average)} FPS)`);
      } else if (this.quality === 'balanced' && average < 26) {
        this.applyQuality('low', `dropped to low (${Math.round(average)} FPS)`);
      }
    }
  }

  private updateCamera(): void {
    const radius = this.distance;
    const x = Math.sin(this.yaw) * Math.cos(this.pitch) * radius;
    const y = this.target.y + Math.sin(this.pitch) * radius * 0.85;
    const z = Math.cos(this.yaw) * Math.cos(this.pitch) * radius;
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.target);
  }

  handleResize(): void {
    const width = this.canvas.clientWidth || 640;
    const height = this.canvas.clientHeight || 480;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.pause();
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.rig?.dispose();
    this.rig = undefined;
    this.renderer.dispose();
  }
}

function touchDistance(event: TouchEvent): number {
  const [first, second] = [event.touches[0], event.touches[1]];
  if (!first || !second) return 0;
  return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
}
