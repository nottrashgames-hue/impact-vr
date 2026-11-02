import RAPIER from '@dimforge/rapier3d-compat';
import { type Bone, Matrix4, Quaternion, Vector3 } from 'three';
import type { Physics } from '../core/Physics';
import type { Hitboxes } from './Hitboxes';
import { CANONICAL_BONES, type CanonicalBone, type HumanoidRig } from './HumanoidRig';

/**
 * Joints between hitbox bodies: [parent, child, angular limit (rad), muscle
 * tone frequency (rad/s)].
 *
 * Rapier's spherical joints keep the bodies connected; the angular limits
 * are enforced here as soft constraints relative to the pose at the moment
 * of the knockout (works for any rig's bone axes): a weak "muscle tone"
 * spring everywhere, and a much stiffer one past the limit, so the neck,
 * spine, elbows and knees never fold unnaturally.
 *
 * Gains are specified as natural frequencies and scaled by each joint's
 * reduced inertia every step, so light bodies (neck, hands) get
 * proportionally small torques. That keeps the explicit torque impulses
 * stable at the 90 Hz step (ω·dt stays well below 1).
 */
const JOINTS: readonly (readonly [CanonicalBone, CanonicalBone, number, number])[] = [
  ['Hips', 'Spine1', 0.5, 7],
  ['Spine1', 'Spine2', 0.45, 7],
  ['Spine2', 'Neck', 0.45, 6],
  ['Neck', 'Head', 0.6, 5],
  ['Spine2', 'LeftArm', 1.5, 2.5],
  ['LeftArm', 'LeftForeArm', 1.3, 2],
  ['LeftForeArm', 'LeftHand', 0.9, 2],
  ['Spine2', 'RightArm', 1.5, 2.5],
  ['RightArm', 'RightForeArm', 1.3, 2],
  ['RightForeArm', 'RightHand', 0.9, 2],
  ['Hips', 'LeftUpLeg', 1.1, 3],
  ['LeftUpLeg', 'LeftLeg', 1.3, 2.5],
  ['Hips', 'RightUpLeg', 1.1, 3],
  ['RightUpLeg', 'RightLeg', 1.3, 2.5],
];

/** Natural frequency (rad/s) of the stiff spring past a joint's limit. */
const LIMIT_FREQUENCY = 32;
/** Damping of relative spin: frequency (rad/s) and damping ratio. */
const DAMPING_FREQUENCY = 12;
const DAMPING_RATIO = 0.7;

/** Bodies that get continuous collision detection (they hit the floor hardest). */
const CCD_BONES: readonly CanonicalBone[] = ['Head', 'Spine2', 'Spine1', 'Hips'];

interface JointState {
  readonly parent: RAPIER.RigidBody;
  readonly child: RAPIER.RigidBody;
  readonly joint: RAPIER.ImpulseJoint;
  /** Parent-to-child rotation at activation (the "relaxed" pose). */
  readonly reference: Quaternion;
  readonly limit: number;
  /** Muscle-tone natural frequency (rad/s). */
  readonly tone: number;
}

interface PoseTrack {
  readonly bone: Bone;
  readonly body: RAPIER.RigidBody;
  readonly prevPos: Vector3;
  readonly prevQuat: Quaternion;
  readonly pos: Vector3;
  readonly quat: Quaternion;
}

const _p = new Vector3();
const _s = new Vector3();
const _q = new Quaternion();
const _qp = new Quaternion();
const _qc = new Quaternion();
const _dev = new Quaternion();
const _frame = new Quaternion();
const _axis = new Vector3();
const _wp = new Vector3();
const _wc = new Vector3();
const _torque = new Vector3();
const _inv = new Matrix4();

/** Full-body knockout ragdoll built from the opponent's hitbox bodies (Section 3). */
export class Ragdoll {
  private joints: JointState[] = [];
  private readonly tracks: PoseTrack[] = [];
  private _active = false;

  constructor(
    private readonly physics: Physics,
    private readonly rig: HumanoidRig,
    hitboxes: Hitboxes,
  ) {
    // Parents first (canonical order), so bones can be posed top-down.
    for (const name of CANONICAL_BONES) {
      const bone = rig.bones[name];
      const body = bone ? hitboxes.bodyFor(bone) : undefined;
      if (!bone || !body) continue;
      this.tracks.push({ bone, body, prevPos: new Vector3(), prevQuat: new Quaternion(), pos: new Vector3(), quat: new Quaternion() });
    }
  }

  get active(): boolean {
    return this._active;
  }

  /**
   * Goes limp from the current animated pose and applies the knockout blow.
   * @param impulse world impulse (N·s) applied at `point` on `struckBone`'s body
   */
  activate(struckBone: CanonicalBone, point: Vector3, impulse: Vector3): void {
    if (this._active) return;
    this._active = true;
    const world = this.physics.world;

    for (const t of this.tracks) {
      t.bone.matrixWorld.decompose(_p, _q, _s);
      t.body.setTranslation(_p, true);
      t.body.setRotation(_q, true);
      t.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      t.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      t.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      t.body.setLinearDamping(0.2);
      t.body.setAngularDamping(1.2);
      t.prevPos.copy(_p);
      t.pos.copy(_p);
      t.prevQuat.copy(_q);
      t.quat.copy(_q);
    }
    for (const name of CCD_BONES) {
      const bone = this.rig.bones[name];
      if (bone) this.bodyOf(bone)?.enableCcd(true);
    }

    this.joints = [];
    for (const [parentName, childName, limit, tone] of JOINTS) {
      const parentBone = this.rig.bones[parentName];
      const childBone = this.rig.bones[childName];
      const parent = parentBone && this.bodyOf(parentBone);
      const child = childBone && this.bodyOf(childBone);
      if (!parentBone || !childBone || !parent || !child) continue;
      // Anchor at the child bone's origin (= the child body's origin).
      parentBone.matrixWorld.decompose(_p, _q, _s);
      const anchor1 = childBone.getWorldPosition(new Vector3()).sub(_p).applyQuaternion(_q.invert());
      const joint = world.createImpulseJoint(
        RAPIER.JointData.spherical(anchor1, { x: 0, y: 0, z: 0 }),
        parent,
        child,
        true,
      );
      joint.setContactsEnabled(false);
      const reference = quat(parent.rotation()).invert().multiply(quat(child.rotation()));
      this.joints.push({ parent, child, joint, reference, limit, tone });
    }

    const struck = this.rig.bones[struckBone];
    const body = (struck && this.bodyOf(struck)) ?? this.tracks[0]?.body;
    body?.applyImpulseAtPoint(impulse, point, true);
  }

  /** Extra shove while already down (punching a downed opponent). */
  applyImpulse(bone: CanonicalBone, point: Vector3, impulse: Vector3): void {
    const b = this.rig.bones[bone];
    const body = b ? this.bodyOf(b) : undefined;
    body?.applyImpulseAtPoint(impulse, point, true);
  }

  /** Soft joint limits; call before each physics step. */
  beforeStep(dt: number): void {
    if (!this._active) return;
    for (const t of this.tracks) {
      t.prevPos.copy(t.pos);
      t.prevQuat.copy(t.quat);
    }
    for (const j of this.joints) {
      // Reduced inertia of the pair: the effective inertia of their relative rotation.
      const ip = meanInertia(j.parent);
      const ic = meanInertia(j.child);
      if (ip <= 0 || ic <= 0) continue; // mass properties not ready yet
      const inertia = (ip * ic) / (ip + ic);

      quat(j.parent.rotation(), _qp);
      quat(j.child.rotation(), _qc);
      // Deviation from the reference pose: child = parent * reference * deviation.
      _dev.copy(_qp).multiply(j.reference).invert().multiply(_qc);
      if (_dev.w < 0) _dev.set(-_dev.x, -_dev.y, -_dev.z, -_dev.w);
      const angle = 2 * Math.acos(Math.min(1, _dev.w));
      const sinHalf = Math.sqrt(Math.max(0, 1 - _dev.w * _dev.w));
      _torque.set(0, 0, 0);
      if (angle > 1e-4 && sinHalf > 1e-6) {
        // Axis of the deviation, expressed in world space.
        _axis.set(_dev.x, _dev.y, _dev.z).divideScalar(sinHalf);
        _frame.copy(_qp).multiply(j.reference);
        _axis.applyQuaternion(_frame);
        const excess = Math.max(0, angle - j.limit);
        const stiffness = j.tone * j.tone * angle + LIMIT_FREQUENCY * LIMIT_FREQUENCY * excess;
        _torque.copy(_axis).multiplyScalar(-stiffness * inertia);
      }
      // Damp the relative spin.
      const wc = j.child.angvel();
      const wp = j.parent.angvel();
      _wc.set(wc.x, wc.y, wc.z);
      _wp.set(wp.x, wp.y, wp.z);
      _torque.addScaledVector(_wc.sub(_wp), -2 * DAMPING_RATIO * DAMPING_FREQUENCY * inertia);
      _torque.multiplyScalar(dt);
      j.child.applyTorqueImpulse(_torque, true);
      j.parent.applyTorqueImpulse(_torque.negate(), true);
    }
  }

  /** Records the post-step body poses for interpolation. */
  afterStep(): void {
    if (!this._active) return;
    for (const t of this.tracks) {
      const p = t.body.translation();
      t.pos.set(p.x, p.y, p.z);
      quat(t.body.rotation(), t.quat);
    }
  }

  /** Poses the bones from the bodies, interpolated between the last two physics steps. */
  syncBones(alpha: number): void {
    if (!this._active) return;
    for (const t of this.tracks) {
      _p.copy(t.prevPos).lerp(t.pos, alpha);
      _q.copy(t.prevQuat).slerp(t.quat, alpha);
      const parent = t.bone.parent;
      if (parent) {
        _inv.copy(parent.matrixWorld).invert();
        t.bone.position.copy(_p.applyMatrix4(_inv));
        parent.getWorldQuaternion(_qp).invert();
        t.bone.quaternion.copy(_qp.multiply(_q));
      } else {
        t.bone.position.copy(_p);
        t.bone.quaternion.copy(_q);
      }
      t.bone.updateMatrixWorld(true);
    }
  }

  /** Back to kinematic, animation-driven bodies. */
  deactivate(): void {
    if (!this._active) return;
    this._active = false;
    for (const j of this.joints) this.physics.world.removeImpulseJoint(j.joint, true);
    this.joints = [];
    for (const t of this.tracks) {
      t.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      t.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
      t.body.enableCcd(false);
      t.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    }
  }

  private bodyOf(bone: Bone): RAPIER.RigidBody | undefined {
    return this.tracks.find((t) => t.bone === bone)?.body;
  }
}

function quat(r: { x: number; y: number; z: number; w: number }, out = new Quaternion()): Quaternion {
  return out.set(r.x, r.y, r.z, r.w);
}

/** Average principal moment of inertia (kg·m²) about the body's centre of mass. */
function meanInertia(body: RAPIER.RigidBody): number {
  const i = body.principalInertia();
  return (i.x + i.y + i.z) / 3;
}
