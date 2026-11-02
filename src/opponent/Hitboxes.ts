import RAPIER from '@dimforge/rapier3d-compat';
import {
  type Bone,
  BoxGeometry,
  type BufferGeometry,
  CapsuleGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { COLLISION_GROUP, interactionGroups, type Physics } from '../core/Physics';
import { ZONES, type ZoneId } from '../damage/Zones';
import type { CanonicalBone, HumanoidRig, RestPose } from './HumanoidRig';

/** Shapes are authored in character rest space for a 1.8 m rig, then scaled. */
type ShapeDef =
  /** Capsule between two joints. */
  | { readonly kind: 'segment'; readonly from: CanonicalBone; readonly to: CanonicalBone; readonly radius: number }
  /** Vertical capsule around a point relative to the head centre. */
  | { readonly kind: 'skull'; readonly offset: readonly [number, number, number]; readonly radius: number; readonly halfHeight: number }
  /** Sphere at the head centre + offset. */
  | { readonly kind: 'headBall'; readonly offset: readonly [number, number, number]; readonly radius: number }
  /** Sphere along the bone towards its child bone. */
  | { readonly kind: 'ball'; readonly towards: CanonicalBone; readonly distance: number; readonly radius: number | 'hand' }
  /** Rounded box around the bone's rest position + offset (character axes). */
  | { readonly kind: 'box'; readonly offset: readonly [number, number, number]; readonly half: readonly [number, number, number] };

interface HitboxDef {
  readonly name: string;
  readonly bone: CanonicalBone;
  readonly zone: ZoneId;
  readonly shape: ShapeDef;
}

/**
 * Hitbox layout (Section 5). The head gets a skull capsule plus a face sphere;
 * both report zone 'head' and the exact face region is resolved by raycasting
 * the head mesh and reading the face-region UV mask.
 */
const HITBOXES: readonly HitboxDef[] = [
  { name: 'skull', bone: 'Head', zone: 'head', shape: { kind: 'skull', offset: [0, 0, -0.005], radius: 0.088, halfHeight: 0.026 } },
  { name: 'face', bone: 'Head', zone: 'head', shape: { kind: 'headBall', offset: [0, -0.045, 0.06], radius: 0.063 } },
  { name: 'neck', bone: 'Neck', zone: 'head', shape: { kind: 'segment', from: 'Neck', to: 'Head', radius: 0.05 } },
  { name: 'chest', bone: 'Spine2', zone: 'torso', shape: { kind: 'box', offset: [0, 0.07, 0.005], half: [0.165, 0.105, 0.105] } },
  { name: 'abdomen', bone: 'Spine1', zone: 'stomach', shape: { kind: 'box', offset: [0, -0.02, 0.01], half: [0.145, 0.1, 0.095] } },
  { name: 'pelvis', bone: 'Hips', zone: 'stomach', shape: { kind: 'box', offset: [0, -0.04, -0.01], half: [0.165, 0.08, 0.11] } },
  ...(['Left', 'Right'] as const).flatMap((side): HitboxDef[] => [
    { name: `${side} upper arm`, bone: `${side}Arm`, zone: 'arms', shape: { kind: 'segment', from: `${side}Arm`, to: `${side}ForeArm`, radius: 0.048 } },
    { name: `${side} forearm`, bone: `${side}ForeArm`, zone: 'arms', shape: { kind: 'segment', from: `${side}ForeArm`, to: `${side}Hand`, radius: 0.042 } },
    { name: `${side} glove`, bone: `${side}Hand`, zone: 'arms', shape: { kind: 'ball', towards: `${side}HandTip`, distance: 0.08, radius: 'hand' } },
    { name: `${side} thigh`, bone: `${side}UpLeg`, zone: 'legs', shape: { kind: 'segment', from: `${side}UpLeg`, to: `${side}Leg`, radius: 0.075 } },
    { name: `${side} shin`, bone: `${side}Leg`, zone: 'legs', shape: { kind: 'segment', from: `${side}Leg`, to: `${side}Foot`, radius: 0.052 } },
  ]),
];

export interface HitboxInfo {
  readonly name: string;
  readonly zone: ZoneId;
  readonly bone: CanonicalBone;
  /**
   * True for the skull, face and neck colliders: their hits are refined against
   * the head mesh (a chin shot can clip the neck capsule first).
   */
  readonly isHead: boolean;
}

interface BodyEntry {
  readonly name: CanonicalBone;
  readonly bone: Bone;
  readonly body: RAPIER.RigidBody;
  readonly debug: { readonly mesh: Mesh; readonly local: Matrix4 }[];
}

const UP = new Vector3(0, 1, 0);
const BODY_DENSITY = 985;
/**
 * Share of total body mass per segment (Dempster / Winter anthropometric
 * tables; the feet are folded into the shins). Densities are rescaled per
 * body so the ragdoll's weight sits where a real body's does.
 */
const SEGMENT_MASS: Partial<Record<CanonicalBone, number>> = {
  Head: 0.069,
  Neck: 0.012,
  Spine2: 0.216,
  Spine1: 0.139,
  Hips: 0.142,
  LeftArm: 0.028,
  RightArm: 0.028,
  LeftForeArm: 0.016,
  RightForeArm: 0.016,
  LeftHand: 0.006,
  RightHand: 0.006,
  LeftUpLeg: 0.1,
  RightUpLeg: 0.1,
  LeftLeg: 0.061,
  RightLeg: 0.061,
};
const _p = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _m = new Matrix4();

/**
 * Kinematic physics bodies that follow the animated bones (one body per bone,
 * one or more colliders per body). Milestone 3 turns them dynamic and joins
 * them for the active ragdoll.
 */
export class Hitboxes {
  /** Colour-coded collider shapes, shown in debug mode. */
  readonly debugGroup = new Group();
  private readonly entries: BodyEntry[] = [];
  private readonly byCollider = new Map<number, HitboxInfo>();

  constructor(
    private readonly physics: Physics,
    rig: HumanoidRig,
    rest: RestPose,
  ) {
    this.debugGroup.name = 'hitbox-debug';
    this.debugGroup.visible = false;
    const s = rig.height / 1.8;
    // Torso-side parts accept self-collision from the ragdoll's limbs (they never touch each other).
    const groups = interactionGroups(
      COLLISION_GROUP.OPPONENT,
      COLLISION_GROUP.PLAYER | COLLISION_GROUP.STATIC | COLLISION_GROUP.OPPONENT_SELF,
    );
    const bodies = new Map<Bone, BodyEntry>();
    const restPos = new Vector3();
    const restQuat = new Quaternion();
    const restQuatInv = new Quaternion();

    for (const def of HITBOXES) {
      const bone = rig.bones[def.bone];
      if (!bone) continue;
      const shape = resolveShape(def.shape, rig, rest, s, bone);
      if (!shape) continue;

      let entry = bodies.get(bone);
      if (!entry) {
        bone.getWorldPosition(_p);
        bone.getWorldQuaternion(_q);
        const body = physics.world.createRigidBody(
          RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(_p.x, _p.y, _p.z).setRotation(_q),
        );
        entry = { name: def.bone, bone, body, debug: [] };
        bodies.set(bone, entry);
        this.entries.push(entry);
      }

      // Character-space shape transform -> bone-local offset (unscaled).
      rest.characterPosition(bone, restPos);
      rest.characterQuaternion(bone, restQuat);
      restQuatInv.copy(restQuat).invert();
      const localPos = shape.center.clone().sub(restPos).applyQuaternion(restQuatInv);
      const localRot = restQuatInv.clone().multiply(shape.rotation);

      const collider = physics.world.createCollider(
        shape.desc
          .setTranslation(localPos.x, localPos.y, localPos.z)
          .setRotation(localRot)
          .setCollisionGroups(groups)
          // ≈ body density (kg/m³): gives a ~70 kg ragdoll from these volumes.
          .setDensity(BODY_DENSITY)
          .setFriction(0.8),
        entry.body,
      );
      this.byCollider.set(collider.handle, {
        name: def.name,
        zone: def.zone,
        bone: def.bone,
        isHead: def.bone === 'Head' || def.bone === 'Neck',
      });

      const mesh = new Mesh(
        shape.debugGeometry,
        new MeshBasicMaterial({ color: ZONES[def.zone].color, wireframe: true, transparent: true, opacity: 0.9, depthTest: false }),
      );
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 20;
      mesh.name = `hitbox:${def.name}`;
      this.debugGroup.add(mesh);
      entry.debug.push({ mesh, local: new Matrix4().compose(localPos, localRot, new Vector3(1, 1, 1)) });
    }
    this.distributeMass();
  }

  /** Keeps the total mass (density × volume) but redistributes it per segment. */
  private distributeMass(): void {
    const volumeOf = (body: RAPIER.RigidBody): number => {
      let v = 0;
      for (let i = 0; i < body.numColliders(); i++) v += body.collider(i).volume();
      return v;
    };
    const total = this.entries.reduce((sum, e) => sum + volumeOf(e.body), 0) * BODY_DENSITY;
    const share = this.entries.reduce((sum, e) => sum + (SEGMENT_MASS[e.name] ?? 0), 0);
    for (const entry of this.entries) {
      const fraction = SEGMENT_MASS[entry.name];
      const volume = volumeOf(entry.body);
      if (!fraction || volume <= 0) continue;
      const density = ((fraction / share) * total) / volume;
      for (let i = 0; i < entry.body.numColliders(); i++) entry.body.collider(i).setDensity(density);
    }
  }

  get colliderCount(): number {
    return this.byCollider.size;
  }

  setDebugVisible(visible: boolean): void {
    this.debugGroup.visible = visible;
  }

  lookup(collider: RAPIER.Collider): HitboxInfo | undefined {
    return this.byCollider.get(collider.handle);
  }

  /** The physics body that follows a bone (the ragdoll reuses these). */
  bodyFor(bone: Bone): RAPIER.RigidBody | undefined {
    return this.entries.find((e) => e.bone === bone)?.body;
  }

  /** Total mass of the opponent's bodies (kg). */
  get totalMass(): number {
    return this.entries.reduce((sum, e) => sum + e.body.mass(), 0);
  }

  /**
   * Pushes the current bone poses to the kinematic bodies (applied on the next
   * physics step). `teleport` moves them immediately, e.g. after a reset.
   */
  sync(teleport = false): void {
    for (const entry of this.entries) {
      entry.bone.matrixWorld.decompose(_p, _q, _s);
      if (teleport) {
        entry.body.setTranslation(_p, true);
        entry.body.setRotation(_q, true);
      } else {
        entry.body.setNextKinematicTranslation(_p);
        entry.body.setNextKinematicRotation(_q);
      }
      this.placeDebug(entry);
    }
  }

  /** Debug shapes only (while the ragdoll drives the bodies). */
  syncDebug(): void {
    if (!this.debugGroup.visible) return;
    for (const entry of this.entries) {
      entry.bone.matrixWorld.decompose(_p, _q, _s);
      this.placeDebug(entry);
    }
  }

  private placeDebug(entry: BodyEntry): void {
    if (!this.debugGroup.visible) return;
    _m.compose(_p, _q, _s.set(1, 1, 1));
    for (const d of entry.debug) {
      d.mesh.matrix.multiplyMatrices(_m, d.local);
      d.mesh.matrixWorldNeedsUpdate = true;
    }
  }

  dispose(): void {
    for (const entry of this.entries) this.physics.world.removeRigidBody(entry.body);
    this.entries.length = 0;
    this.byCollider.clear();
  }
}

interface ResolvedShape {
  readonly desc: RAPIER.ColliderDesc;
  /** Shape centre and orientation in character rest space. */
  readonly center: Vector3;
  readonly rotation: Quaternion;
  readonly debugGeometry: BufferGeometry;
}

function resolveShape(shape: ShapeDef, rig: HumanoidRig, rest: RestPose, s: number, bone: Bone): ResolvedShape | null {
  const identity = new Quaternion();
  switch (shape.kind) {
    case 'segment': {
      const a = rig.bones[shape.from];
      const b = rig.bones[shape.to];
      if (!a || !b) return null;
      const pa = rest.characterPosition(a, new Vector3());
      const pb = rest.characterPosition(b, new Vector3());
      const axis = new Vector3().subVectors(pb, pa);
      const r = shape.radius * s;
      const halfHeight = Math.max(0.005, axis.length() / 2 - r * 0.5);
      return {
        desc: RAPIER.ColliderDesc.capsule(halfHeight, r),
        center: pa.clone().add(pb).multiplyScalar(0.5),
        rotation: new Quaternion().setFromUnitVectors(UP, axis.normalize()),
        debugGeometry: new CapsuleGeometry(r, halfHeight * 2, 4, 10),
      };
    }
    case 'skull': {
      const r = shape.radius * s;
      const hh = shape.halfHeight * s;
      return {
        desc: RAPIER.ColliderDesc.capsule(hh, r),
        center: offsetFrom(rig.headCenter, shape.offset, s),
        rotation: identity,
        debugGeometry: new CapsuleGeometry(r, hh * 2, 6, 14),
      };
    }
    case 'headBall': {
      const r = shape.radius * s;
      return {
        desc: RAPIER.ColliderDesc.ball(r),
        center: offsetFrom(rig.headCenter, shape.offset, s),
        rotation: identity,
        debugGeometry: new SphereGeometry(r, 14, 10),
      };
    }
    case 'ball': {
      const target = rig.bones[shape.towards];
      const p = rest.characterPosition(bone, new Vector3());
      if (target) {
        const dir = rest.characterPosition(target, new Vector3()).sub(p).normalize();
        p.addScaledVector(dir, shape.distance * s);
      }
      const r = shape.radius === 'hand' ? rig.handRadius : shape.radius * s;
      return { desc: RAPIER.ColliderDesc.ball(r), center: p, rotation: identity, debugGeometry: new SphereGeometry(r, 12, 8) };
    }
    case 'box': {
      const [hx, hy, hz] = shape.half.map((h) => h * s);
      return {
        desc: RAPIER.ColliderDesc.roundCuboid(hx - 0.02 * s, hy - 0.02 * s, hz - 0.02 * s, 0.02 * s),
        center: offsetFrom(rest.characterPosition(bone, new Vector3()), shape.offset, s),
        rotation: identity,
        debugGeometry: new BoxGeometry(hx * 2, hy * 2, hz * 2),
      };
    }
  }
}

function offsetFrom(base: Vector3, offset: readonly [number, number, number], s: number): Vector3 {
  return base.clone().add(new Vector3(offset[0], offset[1], offset[2]).multiplyScalar(s));
}
