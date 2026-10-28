import { AnimationMixer, Euler, LoopRepeat, MathUtils, type AnimationAction, type AnimationClip, type Object3D } from 'three';
import type { AvatarBone, AvatarRig } from './types';
import type { Emotion, Gesture } from '../types/emotion';
import { estimateDuration } from './AvatarScheduler';

/**
 * Motion controller (PLAN §5.2, §5.4).
 *
 * Exclusive owner of the skeleton: idle posture, breathing, gestures, gaze and
 * the VRMA clip layer all write through here, so two systems can never fight
 * over the same bone. Fallback order for a requested gesture is
 * requested → any mood-compatible clip → subtle generic motion → idle.
 */

interface BoneRest {
  bone: Object3D;
  rotation: Euler;
  position: { x: number; y: number; z: number };
}

interface ActiveGesture {
  name: Gesture;
  startedAt: number;
  duration: number;
}

export interface MotionControllerOptions {
  rig: AvatarRig;
  mixer?: AnimationMixer;
  /** Base idle sway amplitude multiplier (personality expressiveness). */
  expressiveness?: number;
}

export class AvatarMotionController {
  private readonly rig: AvatarRig;
  private readonly mixer: AnimationMixer;
  private readonly expressiveness: number;
  private readonly rest = new Map<AvatarBone, BoneRest>();
  private readonly actions = new Map<string, AnimationAction>();
  private activeGesture?: ActiveGesture;
  private speaking = false;
  private listening = false;
  private gazeYaw = 0;
  private gazePitch = 0;
  private targetYaw = 0;
  private targetPitch = 0;
  private currentAction?: AnimationAction;

  constructor(options: MotionControllerOptions) {
    this.rig = options.rig;
    this.mixer = options.mixer ?? new AnimationMixer(options.rig.root);
    this.expressiveness = options.expressiveness ?? 1;
    this.cacheRestPose();
    this.registerClips(this.rig.clips());
  }

  private cacheRestPose(): void {
    const bones: AvatarBone[] = [
      'hips',
      'spine',
      'chest',
      'neck',
      'head',
      'leftShoulder',
      'leftUpperArm',
      'leftLowerArm',
      'rightShoulder',
      'rightUpperArm',
      'rightLowerArm',
    ];
    for (const name of bones) {
      const bone = this.rig.getBone(name);
      if (!bone) continue;
      this.rest.set(name, {
        bone,
        rotation: bone.rotation.clone(),
        position: { x: bone.position.x, y: bone.position.y, z: bone.position.z },
      });
    }
  }

  registerClips(clips: Array<{ name: string; clip: AnimationClip }>): void {
    for (const entry of clips) {
      const action = this.mixer.clipAction(entry.clip);
      action.setLoop(LoopRepeat, Infinity);
      action.clampWhenFinished = false;
      this.actions.set(entry.name.toLowerCase(), action);
    }
  }

  /** Crossfade to a named VRMA clip when the avatar has one. */
  playClip(name: string, fadeSeconds = 0.35): boolean {
    const action = this.actions.get(name.toLowerCase());
    if (!action) return false;
    if (this.currentAction === action) return true;
    action.reset().setEffectiveWeight(1).fadeIn(fadeSeconds).play();
    this.currentAction?.fadeOut(fadeSeconds);
    this.currentAction = action;
    return true;
  }

  playClipForEmotion(emotion: Emotion): boolean {
    const candidates = [emotion, 'idle', 'neutral'];
    for (const candidate of candidates) {
      if (this.playClip(candidate)) return true;
    }
    return false;
  }

  /** Start a gesture. Returns the gesture actually played (after fallbacks). */
  playGesture(gesture: Gesture, now = Date.now()): Gesture {
    if (this.activeGesture && now - this.activeGesture.startedAt < this.activeGesture.duration * 1000) {
      return this.activeGesture.name;
    }
    const resolved = gesture === 'none' ? 'none' : gesture;
    if (resolved === 'none') {
      return 'none';
    }
    const duration = GESTURE_DURATIONS[resolved] ?? 1.2;
    this.activeGesture = { name: resolved, startedAt: now, duration };
    return resolved;
  }

  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
    if (speaking) this.listening = false;
  }

  setListening(listening: boolean): void {
    this.listening = listening;
    if (listening) this.speaking = false;
  }

  setGazeTarget(yaw: number, pitch: number): void {
    this.targetYaw = MathUtils.clamp(yaw, -0.45, 0.45);
    this.targetPitch = MathUtils.clamp(pitch, -0.3, 0.3);
  }

  update(deltaSeconds: number, elapsedSeconds: number): void {
    this.mixer.update(deltaSeconds);

    // Idle breathing + sway: the base layer, always applied first.
    const breath = Math.sin(elapsedSeconds * 1.6) * 0.012 * this.expressiveness;
    const sway = Math.sin(elapsedSeconds * 0.6) * 0.02 * this.expressiveness;
    const chest = this.rest.get('chest');
    if (chest) {
      chest.bone.rotation.x = chest.rotation.x + breath * (this.speaking ? 1.6 : 1);
      chest.bone.rotation.z = chest.rotation.z + sway * 0.5;
    }
    const spine = this.rest.get('spine');
    if (spine) {
      spine.bone.rotation.y = spine.rotation.y + sway;
    }
    const hips = this.rest.get('hips');
    if (hips) {
      hips.bone.position.y = hips.position.y + Math.sin(elapsedSeconds * 1.6) * 0.004;
    }

    // Gaze: damped follow so the eyes and head lead naturally.
    this.gazeYaw += (this.targetYaw - this.gazeYaw) * Math.min(1, deltaSeconds * 3.5);
    this.gazePitch += (this.targetPitch - this.gazePitch) * Math.min(1, deltaSeconds * 3.5);
    const head = this.rest.get('head');
    if (head) {
      head.bone.rotation.y = head.rotation.y + this.gazeYaw * 0.6;
      head.bone.rotation.x = head.rotation.x + this.gazePitch * 0.4;
      if (this.listening) {
        head.bone.rotation.z = head.rotation.z + Math.sin(elapsedSeconds * 0.9) * 0.05;
      }
    }
    const neck = this.rest.get('neck');
    if (neck) {
      neck.bone.rotation.y = neck.rotation.y + this.gazeYaw * 0.25;
    }
    this.rig.lookAt(this.gazeYaw, this.gazePitch);

    // Gesture layer plays on top of idle and releases bones when finished.
    if (this.activeGesture) {
      const progress = (Date.now() - this.activeGesture.startedAt) / (this.activeGesture.duration * 1000);
      if (progress >= 1) {
        this.releaseGesture();
      } else {
        this.applyGesture(this.activeGesture.name, progress, deltaSeconds);
      }
    }
  }

  private applyGesture(gesture: Gesture, progress: number, deltaSeconds: number): void {
    const envelope = Math.sin(Math.PI * Math.min(1, Math.max(0, progress)));
    switch (gesture) {
      case 'wave': {
        const arm = this.rest.get('rightUpperArm');
        const forearm = this.rest.get('rightLowerArm');
        if (arm) {
          arm.bone.rotation.z = arm.rotation.z - 2.1 * envelope;
          arm.bone.rotation.x = arm.rotation.x - 0.3 * envelope;
        }
        if (forearm) {
          forearm.bone.rotation.z = forearm.rotation.z + Math.sin(progress * Math.PI * 6) * 0.5 * envelope;
        }
        break;
      }
      case 'celebrate': {
        for (const name of ['leftUpperArm', 'rightUpperArm'] as const) {
          const arm = this.rest.get(name);
          if (!arm) continue;
          const sign = name === 'leftUpperArm' ? 1 : -1;
          arm.bone.rotation.z = arm.rotation.z + sign * 2.4 * envelope;
        }
        const head = this.rest.get('head');
        if (head) head.bone.rotation.x = head.rotation.x - 0.18 * envelope;
        break;
      }
      case 'nod':
      case 'nod_slow': {
        const head = this.rest.get('head');
        const speed = gesture === 'nod' ? 9 : 4.5;
        if (head) head.bone.rotation.x = head.rotation.x + Math.sin(progress * Math.PI * speed) * 0.22 * envelope;
        break;
      }
      case 'shake_head': {
        const head = this.rest.get('head');
        if (head) head.bone.rotation.y = head.bone.rotation.y + Math.sin(progress * Math.PI * 6) * 0.3 * envelope;
        break;
      }
      case 'head_tilt': {
        const head = this.rest.get('head');
        if (head) head.bone.rotation.z = head.rotation.z + 0.35 * envelope;
        break;
      }
      case 'shrug': {
        for (const name of ['leftShoulder', 'rightShoulder'] as const) {
          const shoulder = this.rest.get(name);
          if (!shoulder) continue;
          shoulder.bone.position.y = shoulder.position.y + 0.03 * envelope;
        }
        break;
      }
      case 'point_up': {
        const arm = this.rest.get('rightUpperArm');
        const forearm = this.rest.get('rightLowerArm');
        if (arm) arm.bone.rotation.z = arm.rotation.z - 1.1 * envelope;
        if (forearm) forearm.bone.rotation.x = forearm.rotation.x - 0.8 * envelope;
        break;
      }
      case 'thumb_up': {
        const arm = this.rest.get('rightUpperArm');
        if (arm) arm.bone.rotation.z = arm.rotation.z - 1.3 * envelope;
        break;
      }
      case 'lean_in': {
        const spine = this.rest.get('spine');
        if (spine) spine.bone.rotation.x = spine.rotation.x + 0.16 * envelope;
        break;
      }
      case 'think_pose': {
        const arm = this.rest.get('rightUpperArm');
        const forearm = this.rest.get('rightLowerArm');
        if (arm) arm.bone.rotation.z = arm.rotation.z - 1.7 * envelope;
        if (forearm) forearm.bone.rotation.x = forearm.rotation.x - 1.5 * envelope;
        break;
      }
      default: {
        // Unknown/unsupported: a subtle idle-linked motion keeps the avatar alive.
        const head = this.rest.get('head');
        if (head) head.bone.rotation.z = head.rotation.z + Math.sin(Date.now() / 700) * 0.02 * deltaSeconds;
        break;
      }
    }
  }

  private releaseGesture(): void {
    this.activeGesture = undefined;
    for (const rest of this.rest.values()) {
      rest.bone.rotation.copy(rest.rotation);
      rest.bone.position.set(rest.position.x, rest.position.y, rest.position.z);
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.actions.clear();
  }
}

const GESTURE_DURATIONS: Partial<Record<Gesture, number>> = {
  wave: 1.4,
  celebrate: 1.1,
  nod: 0.9,
  nod_slow: 1.6,
  shake_head: 1.2,
  head_tilt: 0.9,
  shrug: 1.1,
  point_up: 1.0,
  thumb_up: 0.9,
  lean_in: 1.4,
  think_pose: 1.8,
};

export { estimateDuration };
