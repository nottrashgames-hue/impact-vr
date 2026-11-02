import {
  type Bone,
  type BufferGeometry,
  Matrix4,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  Quaternion,
  type SkinnedMesh,
  Vector3,
} from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import type { FaceRegionLookup } from './FaceRegions';

/**
 * Canonical humanoid bone names. These follow the Ready Player Me / Mixamo
 * naming (minus Mixamo's `mixamorig:` prefix); other rigs are mapped onto them
 * through `OpponentConfig.boneAliases`.
 */
export const CANONICAL_BONES = [
  'Hips',
  'Spine',
  'Spine1',
  'Spine2',
  'Neck',
  'Head',
  'Jaw',
  'LeftEye',
  'RightEye',
  'LeftUpperLid',
  'RightUpperLid',
  'LeftShoulder',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'LeftHandTip',
  'RightShoulder',
  'RightArm',
  'RightForeArm',
  'RightHand',
  'RightHandTip',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'LeftToeBase',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
  'RightToeBase',
] as const;
export type CanonicalBone = (typeof CANONICAL_BONES)[number];

/** Bones every rig must provide (the rest are optional and degrade gracefully). */
export const REQUIRED_BONES = [
  'Hips',
  'Spine',
  'Spine2',
  'Neck',
  'Head',
  'LeftArm',
  'LeftForeArm',
  'LeftHand',
  'RightArm',
  'RightForeArm',
  'RightHand',
  'LeftUpLeg',
  'LeftLeg',
  'LeftFoot',
  'RightUpLeg',
  'RightLeg',
  'RightFoot',
] as const satisfies readonly CanonicalBone[];
type RequiredBone = (typeof REQUIRED_BONES)[number];

export type BoneMap = Partial<Record<CanonicalBone, Bone>> & Readonly<Record<RequiredBone, Bone>>;

/**
 * A head-only copy of the skinned head geometry (bind pose) used for fast
 * raycasts: the hit gives the exact UV for face-region lookup and, later,
 * damage/blood painting. It is posed with the head bone's skinning matrix.
 */
export interface HeadProxy {
  readonly mesh: Mesh;
  readonly bone: Bone;
  /** The head bone's inverse bind matrix from the skeleton. */
  readonly boneInverse: Matrix4;
  /** The skinned mesh's bind matrix. */
  readonly bindMatrix: Matrix4;
  /** Bounding-volume hierarchy over the bind-space geometry (fast raycasts / closest point). */
  readonly bvh: MeshBVH;
}

/** A static bind-space copy of part of the body that blood can run over (same shape as HeadProxy). */
export type SurfaceProxy = HeadProxy;

/**
 * A mesh whose UVs index the opponent's damage/blood paint textures. All
 * surfaces of a rig share one UV layout; `cloth` surfaces render blood as an
 * absorbed stain instead of wet skin (Section 7.4).
 */
export interface PaintSurface {
  /** Bind-space geometry used for painting (may exclude parts that overlap in UV, e.g. eyelids). */
  readonly paintGeometry: BufferGeometry;
  readonly material: MeshStandardMaterial;
  readonly cloth: boolean;
}

/** Optional morph-target blink controls (ARKit-style rigs). */
export interface BlinkMorphs {
  readonly mesh: Mesh;
  readonly left: number;
  readonly right: number;
}

/** Everything the animator, hitboxes and damage systems need from a character. */
export interface HumanoidRig {
  readonly kind: 'procedural' | 'glb';
  /** Placed in the world; character space = this object's local space (feet at y = 0, facing +Z). */
  readonly root: Object3D;
  readonly bones: BoneMap;
  readonly skinnedMeshes: readonly SkinnedMesh[];
  /** Standing height in metres (hitbox sizes scale with it). */
  readonly height: number;
  /** Centre of the skull at eye level, in character rest space. */
  readonly headCenter: Vector3;
  /** Radius of the fist/glove hitbox. */
  readonly handRadius: number;
  readonly headProxies: readonly HeadProxy[];
  /** Upper body surface (chest, belly) that blood can run down. */
  readonly torsoProxies: readonly SurfaceProxy[];
  /** Surfaces that receive bruises and blood (one shared UV layout). */
  readonly paintSurfaces: readonly PaintSurface[];
  /** Skinned mesh whose skeleton/bind matrix define the paint surfaces' bind space. */
  readonly paintReference: SkinnedMesh;
  /** Longest triangle edge of the paint surfaces (bind units), for the painter's vertex culling. */
  readonly paintCullDistance: number;
  readonly faceRegions: FaceRegionLookup;
  readonly blinkMorphs: readonly BlinkMorphs[];
  /** Total triangles across the character's meshes (for the HUD). */
  readonly triangles: number;
  /** Debug: tint the body by damage zone instead of its normal textures. */
  setZoneDebugView(enabled: boolean): void;
}

const _inv = new Matrix4();

/**
 * Snapshot of the bind/rest pose: local transforms (to restore every frame
 * before procedural animation is layered on) and character-space world
 * transforms (to convert character-space targets into bone space for any rig).
 */
export class RestPose {
  private readonly localPos = new Map<Bone, Vector3>();
  private readonly localQuat = new Map<Bone, Quaternion>();
  private readonly charMatrix = new Map<Bone, Matrix4>();
  private readonly charPos = new Map<Bone, Vector3>();
  private readonly charQuat = new Map<Bone, Quaternion>();
  private readonly allBones: Bone[];

  constructor(rig: { root: Object3D; skinnedMeshes: readonly SkinnedMesh[] }) {
    const bones = new Set<Bone>();
    for (const mesh of rig.skinnedMeshes) for (const b of mesh.skeleton.bones) bones.add(b);
    this.allBones = [...bones];

    rig.root.updateMatrixWorld(true);
    _inv.copy(rig.root.matrixWorld).invert();
    const scale = new Vector3();
    for (const bone of this.allBones) {
      this.localPos.set(bone, bone.position.clone());
      this.localQuat.set(bone, bone.quaternion.clone());
      const m = new Matrix4().multiplyMatrices(_inv, bone.matrixWorld);
      const p = new Vector3();
      const q = new Quaternion();
      m.decompose(p, q, scale);
      this.charMatrix.set(bone, m);
      this.charPos.set(bone, p);
      this.charQuat.set(bone, q);
    }
  }

  /** Puts every bone back to its rest local transform. */
  restore(): void {
    for (const bone of this.allBones) {
      bone.position.copy(this.localPos.get(bone) as Vector3);
      bone.quaternion.copy(this.localQuat.get(bone) as Quaternion);
    }
  }

  restLocalQuaternion(bone: Bone): Quaternion {
    return this.localQuat.get(bone) as Quaternion;
  }

  /** Rest transform of a bone in character space. */
  characterMatrix(bone: Bone): Matrix4 {
    return this.charMatrix.get(bone) as Matrix4;
  }

  characterPosition(bone: Bone, out: Vector3): Vector3 {
    return out.copy(this.charPos.get(bone) as Vector3);
  }

  characterQuaternion(bone: Bone, out: Quaternion): Quaternion {
    return out.copy(this.charQuat.get(bone) as Quaternion);
  }
}
