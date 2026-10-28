import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
} from 'three';
import type { AvatarBone, AvatarRig } from './types';
import { EXPRESSIONS } from '../types/emotion';

/**
 * Procedural fallback avatar.
 *
 * Ships instead of a third-party VRM: the repository must not redistribute
 * avatars it has no licence for (PLAN §12.3), and the app should still show a
 * character before the user imports one. It exposes the same rig interface as a
 * VRM, including expression weights, blink and mouth openness, so every control
 * in the UI works immediately.
 */
export function createProceduralAvatar(options: { color?: number } = {}): AvatarRig {
  const root = new Group();
  root.name = 'AURA-procedural-avatar';

  const skin = new MeshStandardMaterial({
    color: new Color(options.color ?? 0x8fc7d8),
    roughness: 0.62,
    metalness: 0.05,
  });
  const accent = new MeshStandardMaterial({ color: 0x2b3a4a, roughness: 0.5 });
  const eyeMaterial = new MeshStandardMaterial({ color: 0x101a24, roughness: 0.25 });
  const mouthMaterial = new MeshStandardMaterial({ color: 0x5a2430, roughness: 0.4 });

  const bones = new Map<AvatarBone, Object3D>();

  const hips = new Object3D();
  hips.name = 'hips';
  hips.position.y = 0.92;
  root.add(hips);
  bones.set('hips', hips);

  const spine = new Object3D();
  spine.name = 'spine';
  spine.position.y = 0.06;
  hips.add(spine);
  bones.set('spine', spine);

  const chest = new Object3D();
  chest.name = 'chest';
  chest.position.y = 0.22;
  spine.add(chest);
  bones.set('chest', chest);

  const torso = new Mesh(new CapsuleGeometry(0.19, 0.3, 8, 18), skin);
  torso.position.y = 0.14;
  chest.add(torso);

  const neck = new Object3D();
  neck.name = 'neck';
  neck.position.y = 0.26;
  chest.add(neck);
  bones.set('neck', neck);

  const head = new Object3D();
  head.name = 'head';
  head.position.y = 0.13;
  neck.add(head);
  bones.set('head', head);

  const headMesh = new Mesh(new SphereGeometry(0.145, 32, 24), skin);
  headMesh.scale.set(0.95, 1.05, 0.95);
  head.add(headMesh);

  const eyeGeometry = new SphereGeometry(0.021, 16, 12);
  const leftEye = new Object3D();
  leftEye.name = 'leftEye';
  leftEye.position.set(-0.052, 0.028, 0.126);
  const leftEyeMesh = new Mesh(eyeGeometry, eyeMaterial);
  leftEye.add(leftEyeMesh);
  head.add(leftEye);
  bones.set('leftEye', leftEye);

  const rightEye = new Object3D();
  rightEye.name = 'rightEye';
  rightEye.position.set(0.052, 0.028, 0.126);
  rightEye.add(new Mesh(eyeGeometry, eyeMaterial));
  head.add(rightEye);
  bones.set('rightEye', rightEye);

  const eyelidMaterial = new MeshStandardMaterial({ color: 0x6fb0c4, roughness: 0.7 });
  const leftLid = new Mesh(new SphereGeometry(0.023, 14, 8), eyelidMaterial);
  leftLid.scale.set(1, 0.05, 1);
  leftLid.position.set(-0.052, 0.03, 0.118);
  head.add(leftLid);
  const rightLid = leftLid.clone();
  rightLid.position.x = 0.052;
  head.add(rightLid);

  const mouth = new Mesh(new SphereGeometry(0.038, 20, 14), mouthMaterial);
  mouth.scale.set(1, 0.12, 0.4);
  mouth.position.set(0, -0.055, 0.124);
  head.add(mouth);

  const expressionTargets = new Map<string, Mesh[]>();

  const browGeometry = new BoxGeometry(0.045, 0.008, 0.01);
  const browMaterial = new MeshStandardMaterial({ color: 0x3d6a78, roughness: 0.6 });
  const leftBrow = new Mesh(browGeometry, browMaterial);
  leftBrow.position.set(-0.052, 0.072, 0.126);
  const rightBrow = leftBrow.clone();
  rightBrow.position.x = 0.052;
  head.add(leftBrow, rightBrow);
  expressionTargets.set('brows', [leftBrow, rightBrow]);

  const addArm = (side: 'left' | 'right'): void => {
    const sign = side === 'left' ? -1 : 1;
    const shoulder = new Object3D();
    shoulder.name = `${side}Shoulder`;
    shoulder.position.set(sign * 0.19, 0.14, 0);
    chest.add(shoulder);
    bones.set(`${side}Shoulder` as AvatarBone, shoulder);

    const upperArm = new Object3D();
    upperArm.name = `${side}UpperArm`;
    upperArm.position.y = -0.02;
    shoulder.add(upperArm);
    bones.set(`${side}UpperArm` as AvatarBone, upperArm);

    const armMesh = new Mesh(new CapsuleGeometry(0.058, 0.25, 6, 14), skin);
    armMesh.position.y = -0.15;
    upperArm.add(armMesh);

    const lowerArm = new Object3D();
    lowerArm.name = `${side}LowerArm`;
    lowerArm.position.y = -0.3;
    upperArm.add(lowerArm);
    bones.set(`${side}LowerArm` as AvatarBone, lowerArm);

    const forearmMesh = new Mesh(new CapsuleGeometry(0.05, 0.22, 6, 14), skin);
    forearmMesh.position.y = -0.13;
    lowerArm.add(forearmMesh);

    const hand = new Object3D();
    hand.name = `${side}Hand`;
    hand.position.y = -0.28;
    lowerArm.add(hand);
    bones.set(`${side}Hand` as AvatarBone, hand);

    const handMesh = new Mesh(new SphereGeometry(0.052, 16, 12), accent);
    handMesh.scale.set(0.85, 1.05, 0.55);
    hand.add(handMesh);
  };
  addArm('left');
  addArm('right');

  for (const side of ['left', 'right'] as const) {
    const upperLeg = new Object3D();
    upperLeg.name = `${side}UpLeg`;
    upperLeg.position.set(side === 'left' ? -0.09 : 0.09, 0, 0);
    hips.add(upperLeg);
    bones.set(`${side}UpLeg` as AvatarBone, upperLeg);

    const legMesh = new Mesh(new CapsuleGeometry(0.07, 0.34, 6, 14), accent);
    legMesh.position.y = -0.22;
    upperLeg.add(legMesh);
  }

  let mouthOpen = 0;
  let blink = 0;
  const weights = new Map<string, number>();
  const baseMouthScale = 0.12;

  const rig: AvatarRig = {
    kind: 'procedural',
    root,
    blinkExpression: 'blink',
    update() {
      // Blink closes the scaled eyelids; expression weights bend the brows.
      const lidScale = Math.max(0.05, 1 - blink * 0.95);
      leftLid.scale.set(1, 0.05 * lidScale + 0.02, 1);
      rightLid.scale.set(1, 0.05 * lidScale + 0.02, 1);

      const brows = expressionTargets.get('brows') ?? [];
      const happiness = weights.get('happy') ?? 0;
      const sadness = weights.get('sad') ?? 0;
      const anger = weights.get('angry') ?? 0;
      const surprise = weights.get('surprised') ?? 0;
      const lift = happiness * 0.012 + surprise * 0.02 - sadness * 0.01 - anger * 0.014;
      for (const brow of brows) {
        brow.position.y = 0.072 + lift;
      }
      const tilt = anger * 0.35 - sadness * 0.25;
      leftBrow.rotation.z = -tilt;
      rightBrow.rotation.z = tilt;

      const roundness = 1 + surprise * 0.25;
      for (const eyeTarget of [leftEye, rightEye]) {
        eyeTarget.scale.setScalar(roundness);
      }

      mouth.scale.set(1 + happiness * 0.45 - surprise * 0.15, baseMouthScale + mouthOpen * 0.5, 0.4);
      mouth.position.y = -0.055 + happiness * 0.004;
    },
    setExpressionWeight(name, weight) {
      weights.set(name, weight);
    },
    hasExpression(name) {
      return (EXPRESSIONS as readonly string[]).includes(name) || name === 'aa' || name === 'blink';
    },
    applyBlink(weight) {
      blink = weight;
    },
    getBone(name) {
      return bones.get(name);
    },
    lookAt(yaw, pitch) {
      const eyeYaw = Math.max(-0.35, Math.min(0.35, yaw));
      const eyePitch = Math.max(-0.25, Math.min(0.25, pitch));
      for (const eyeTarget of [leftEye, rightEye]) {
        eyeTarget.rotation.y = eyeYaw;
        eyeTarget.rotation.x = eyePitch;
      }
    },
    clips() {
      return [];
    },
    availableExpressions() {
      return [...EXPRESSIONS];
    },
    dispose() {
      root.traverse((child) => {
        if (child instanceof Mesh) {
          child.geometry.dispose();
          const material = child.material;
          if (Array.isArray(material)) {
            material.forEach((entry) => entry.dispose());
          } else {
            material.dispose();
          }
        }
      });
      root.clear();
    },
  };

  // Expose mouth openness through the `aa` expression channel for parity with VRM.
  const originalSet = rig.setExpressionWeight.bind(rig);
  rig.setExpressionWeight = (name, weight) => {
    if (name === 'aa') {
      mouthOpen = weight;
      return;
    }
    originalSet(name, weight);
  };

  return rig;
}
