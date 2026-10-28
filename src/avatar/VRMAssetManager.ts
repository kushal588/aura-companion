import { AnimationClip, Group, Object3D, Texture, type WebGLRenderer } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { createVRMAnimationClip, VRMAnimationLoaderPlugin, type VRMAnimation } from '@pixiv/three-vrm-animation';
import type { AvatarBone, AvatarRig } from './types';
import type { ExpressionName } from '../types/emotion';
import { EXPRESSIONS } from '../types/emotion';

/**
 * VRM/VRMA asset loading with resource accounting (PLAN §5.1, §5.2).
 *
 * Import rules enforced here:
 *  - reject anything that is not a GLB/VRM container (magic + size checks);
 *  - never execute scripts referenced by an imported model (three's GLTFLoader
 *    has no script execution path, and extensions are not evaluated as code);
 *  - dispose GPU resources on unload so a memory leak cannot pile up textures;
 *  - report a human-readable summary (bones, expressions, clips, triangles).
 */

export const MAX_VRM_BYTES = 120 * 1024 * 1024;
export const MAX_VRMA_BYTES = 40 * 1024 * 1024;
export const MAX_TEXTURE_BYTES = 64 * 1024 * 1024;

export interface VrmAssetSummary {
  vrmVersion: '0' | '1';
  bones: number;
  expressions: string[];
  clips: string[];
  triangles: number;
  textureBytes: number;
  warnings: string[];
}

export interface LoadedVrm {
  rig: AvatarRig;
  summary: VrmAssetSummary;
  /** Add or replace a VRMA clip; returns the created clip. */
  addAnimation(name: string, animation: VRMAnimation): AnimationClip;
}

export interface AssetLoadResult {
  loaded: LoadedVrm;
  summary: VrmAssetSummary;
}

export class VRMAssetManager {
  private readonly loader: GLTFLoader;
  private current?: LoadedVrm;
  private renderer?: WebGLRenderer;

  constructor() {
    this.loader = new GLTFLoader();
    this.loader.register((parser) => new VRMLoaderPlugin(parser));
    this.loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  }

  /** Keep a renderer reference so we can free GPU resources on unload. */
  bindRenderer(renderer: WebGLRenderer): void {
    this.renderer = renderer;
  }

  get loaded(): LoadedVrm | undefined {
    return this.current;
  }

  static isGlb(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 12) return false;
    const view = new DataView(buffer);
    const magic = view.getUint32(0, true);
    // "glTF" little-endian
    return magic === 0x46546c67;
  }

  async loadVrmFromBuffer(buffer: ArrayBuffer, fileName: string): Promise<AssetLoadResult> {
    if (buffer.byteLength > MAX_VRM_BYTES) {
      throw new Error(
        `That avatar is ${formatBytes(buffer.byteLength)}. The limit is ${formatBytes(MAX_VRM_BYTES)}.`,
      );
    }
    if (!VRMAssetManager.isGlb(buffer)) {
      throw new Error(
        `${fileName} is not a valid VRM/GLB file. AURA imports .vrm models exported as binary glTF.`,
      );
    }

    const gltf = await this.loader.parseAsync(buffer, '');
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) {
      throw new Error('The file is a GLB but contains no VRM data (no VRM extension found).');
    }

    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    // Occlusion culling breaks many VRM outfits; this is the documented fix.
    VRMUtils.combineSkeletons(gltf.scene);
    vrm.scene.traverse((object: Object3D) => {
      object.frustumCulled = false;
    });

    const clips: Array<{ name: string; clip: AnimationClip; animation: VRMAnimation }> = [];
    for (const animation of (gltf.userData.vrmAnimations as VRMAnimation[] | undefined) ?? []) {
      const clip = createVRMAnimationClip(animation, vrm);
      clips.push({ name: clip.name || `clip-${clips.length + 1}`, clip, animation });
    }

    this.disposeCurrent();

    const summary = this.summarize(vrm, clips.map((entry) => entry.name));
    const loaded = this.createLoadedVrm(vrm, clips);
    this.current = loaded;
    return { loaded, summary };
  }

  /** Load a `.vrma` animation file and attach it to the current avatar. */
  async loadAnimationFromBuffer(buffer: ArrayBuffer, name: string): Promise<AnimationClip> {
    if (buffer.byteLength > MAX_VRMA_BYTES) {
      throw new Error(`Animation exceeds ${formatBytes(MAX_VRMA_BYTES)}.`);
    }
    if (!this.current) {
      throw new Error('Import a VRM avatar before adding VRMA animations.');
    }
    const gltf = await this.loader.parseAsync(buffer, '');
    const animations = (gltf.userData.vrmAnimations as VRMAnimation[] | undefined) ?? [];
    const animation = animations[0];
    if (!animation) {
      throw new Error(`${name} contains no VRMA animation data.`);
    }
    const vrm = this.current.rig.root.userData['vrm'] as VRM | undefined;
    if (!vrm) throw new Error('The loaded avatar is not a VRM avatar.');
    const clip = createVRMAnimationClip(animation, vrm);
    clip.name = name.replace(/\.vrma$/i, '');
    this.current.summary.clips.push(clip.name);
    const bucket = this.current as LoadedVrm & { clipStore: Array<{ name: string; clip: AnimationClip }> };
    bucket.clipStore.push({ name: clip.name, clip });
    return clip;
  }

  private createLoadedVrm(
    vrm: VRM,
    clips: Array<{ name: string; clip: AnimationClip; animation: VRMAnimation }>,
  ): LoadedVrm {
    vrm.scene.userData['vrm'] = vrm;
    const clipStore = clips.map((entry) => ({ name: entry.name, clip: entry.clip }));
    const clipNames = clips.map((entry) => entry.name);
    const summary = this.summarize(vrm, clipNames);

    const boneMap = new Map<AvatarBone, Object3D>();
    const availableExpressions: ExpressionName[] = [];
    const expressionManager = vrm.expressionManager;
    for (const expression of EXPRESSIONS) {
      if (expressionManager?.getExpression(expression)) {
        availableExpressions.push(expression);
      }
    }

    // A single gaze target the VRM look-at follows; the motion controller writes
    // yaw/pitch into its position once per frame.
    const gazeTarget = new Object3D();
    gazeTarget.name = 'aura-gaze-target';
    vrm.scene.add(gazeTarget);

    const rig: AvatarRig = {
      kind: 'vrm',
      root: vrm.scene as unknown as Object3D,
      blinkExpression: expressionManager?.getExpression('blink') ? 'blink' : undefined,
      update: (delta) => {
        vrm.update(delta);
      },
      setExpressionWeight: (name, weight) => {
        expressionManager?.setValue(name, Math.max(0, Math.min(1, weight)));
      },
      hasExpression: (name) => Boolean(expressionManager?.getExpression(name)),
      applyBlink: (weight) => {
        if (expressionManager?.getExpression('blink')) {
          expressionManager.setValue('blink', Math.max(0, Math.min(1, weight)));
        }
      },
      getBone: (name) => {
        const cached = boneMap.get(name);
        if (cached) return cached;
        const bone = vrm.humanoid?.getNormalizedBoneNode(name as never) as Object3D | undefined;
        if (bone) {
          boneMap.set(name, bone);
          return bone;
        }
        return undefined;
      },
      lookAt: (yaw, pitch) => {
        if (!vrm.lookAt) return;
        gazeTarget.position.set(yaw * 0.9, 1.42 + pitch * 0.6, 1.6);
        vrm.lookAt.target = gazeTarget;
      },
      clips: () => [...clipStore],
      availableExpressions: () => [...availableExpressions],
      dispose: () => {
        VRMUtils.deepDispose(vrm.scene);
      },
    };

    const loaded: LoadedVrm = {
      rig,
      summary,
      addAnimation: (name, animation) => {
        const clip = createVRMAnimationClip(animation, vrm);
        clip.name = name;
        clipStore.push({ name, clip });
        summary.clips.push(name);
        return clip;
      },
    };
    (loaded as LoadedVrm & { clipStore: typeof clipStore }).clipStore = clipStore;
    return loaded;
  }

  private summarize(vrm: VRM, clipNames: string[]): VrmAssetSummary {
    let bones = 0;
    const humanoid = vrm.humanoid;
    for (const name of [
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
    ] as const) {
      if (humanoid?.getNormalizedBoneNode(name as never)) bones += 1;
    }

    let triangles = 0;
    let textureBytes = 0;
    const textures = new Set<Texture>();
    vrm.scene.traverse((object: Object3D) => {
      const mesh = object as unknown as {
        geometry?: { index?: { count: number } | null; attributes?: { position?: { count: number } } };
        material?: unknown;
      };
      const geometry = mesh.geometry;
      if (geometry) {
        const count = geometry.index?.count ?? geometry.attributes?.position?.count ?? 0;
        triangles += Math.floor(count / 3);
      }
      const material = mesh.material as { map?: Texture } | undefined;
      if (material?.map) textures.add(material.map);
    });
    for (const texture of textures) {
      const image = texture.image as { width?: number; height?: number } | undefined;
      if (image?.width && image.height) {
        textureBytes += image.width * image.height * 4;
      }
    }

    const warnings: string[] = [];
    if (triangles > 200_000) {
      warnings.push(`High polygon count (${triangles.toLocaleString()} triangles) — expect lower FPS.`);
    }
    if (textureBytes > MAX_TEXTURE_BYTES) {
      warnings.push(`Large texture memory (${formatBytes(textureBytes)}) — consider a lighter avatar.`);
    }
    if (bones < 10) {
      warnings.push('The humanoid rig looks incomplete; some gestures may not apply.');
    }
    if (vrm.meta?.metaVersion === '0') {
      warnings.push('This is a VRM 0.x model; expressions are mapped through compatibility mode.');
    }

    return {
      vrmVersion: vrm.meta?.metaVersion === '0' ? '0' : '1',
      bones,
      expressions: (vrm.expressionManager?.expressions ?? []).map((expression) => expression.expressionName),
      clips: [...clipNames],
      triangles,
      textureBytes,
      warnings,
    };
  }

  private disposeCurrent(): void {
    if (!this.current) return;
    try {
      this.current.rig.dispose();
    } catch {
      // Disposal is best-effort; never block loading a new avatar because of it.
    }
    this.current = undefined;
    this.renderer?.renderLists.dispose();
  }

  dispose(): void {
    this.disposeCurrent();
    this.renderer = undefined;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Standalone helper used by the file-import UI. */
export async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

export type { AvatarRig, Group };
