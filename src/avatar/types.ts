import { Object3D } from 'three';
import type { ExpressionName } from '../types/emotion';

/** Humanoid bones the motion controller may drive, in a rig-agnostic naming. */
export const AVATAR_BONES = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpLeg',
  'rightUpLeg',
  'leftEye',
  'rightEye',
] as const;
export type AvatarBone = (typeof AVATAR_BONES)[number];

/**
 * A loaded avatar, whatever it was loaded from.
 *
 * Both the VRM path (`@pixiv/three-vrm`) and the built-in procedural fallback
 * implement this interface, so the expression/motion/lip-sync controllers never
 * branch on avatar type.
 */
export interface AvatarRig {
  readonly kind: 'vrm' | 'procedural';
  readonly root: Object3D;
  /** Per-frame hook (VRM spring bones, procedural idle blending). */
  update(deltaSeconds: number): void;
  setExpressionWeight(name: string, weight: number): void;
  hasExpression(name: string): boolean;
  applyBlink(weight: number): void;
  /** Blink preset name when the rig supports it (`blink` for VRM 1.0). */
  readonly blinkExpression?: string;
  getBone(name: AvatarBone): Object3D | undefined;
  /** Gaze direction; ignored by rigs without eye bones or look-at support. */
  lookAt(yaw: number, pitch: number): void;
  /** Available VRMA clips keyed by clip name (empty for the procedural rig). */
  clips(): Array<{ name: string; clip: import('three').AnimationClip }>;
  /** Preset expressions the loaded model actually exposes. */
  availableExpressions(): ExpressionName[];
  dispose(): void;
}
