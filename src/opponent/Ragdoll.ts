import RAPIER from '@dimforge/rapier3d-compat';
import { type Bone, Matrix4, Quaternion, Vector3 } from 'three';
import { COLLISION_GROUP, interactionGroups, type Physics } from '../core/Physics';
import type { Hitboxes } from './Hitboxes';
import { CANONICAL_BONES, type CanonicalBone, type HumanoidRig, type RestPose } from './HumanoidRig';

/**
 * Anatomical joint model for the knockout ragdoll (Section 3).
 *
 *  - hinge: elbows and knees. Rapier revolute joints lock the two off-axis
 *    rotations in the solver, so they only bend one way; flexion (radians
 *    from a straight limb) is limited to [min, max].
 *  - ball: spine, neck, head, shoulders, hips and wrists. Spherical joints
 *    with a swing cone (half-angle `swing` around the rest bone direction
 *    nudged by `center`, in character space; x is mirrored for the right
 *    side) and a twist limit about the bone.
 *
 * Every joint also has muscle tone: a spring holding the pose the body was in
 * when it was knocked out, fading from `hold` (rad/s) to a faint residual tone
 * with time constant `fade` (s). The legs let go first, so the body crumples
 * at the knees instead of toppling like a plank or flopping like a puppet.
 *
 * Limits and tone are torque impulses scaled by each joint's reduced inertia
 * (gains are natural frequencies), which keeps them stable at the 90 Hz step.
 */
interface JointBase {
  readonly parent: CanonicalBone;
  readonly child: CanonicalBone;
  /** The bone the child segment points at (defines its axis); omit to use parent→child. */
  readonly tip?: CanonicalBone;
  readonly hold: number;
  readonly fade: number;
}
type JointSpec =
  | (JointBase & { readonly kind: 'hinge'; readonly bend: 1 | -1; readonly min: number; readonly max: number })
  | (JointBase & {
      readonly kind: 'ball';
      readonly center: readonly [number, number, number];
      readonly swing: number;
      readonly twist: number;
    });

const ball = (
  parent: CanonicalBone,
  child: CanonicalBone,
  tip: CanonicalBone | undefined,
  center: readonly [number, number, number],
  swing: number,
  twist: number,
  hold: number,
  fade: number,
): JointSpec => ({ kind: 'ball', parent, child, tip, center, swing, twist, hold, fade });

/** `bend` +1: the child swings forward (+Z) when flexing (elbow); -1: backward (knee). */
const hinge = (
  parent: CanonicalBone,
  child: CanonicalBone,
  tip: CanonicalBone,
  bend: 1 | -1,
  min: number,
  max: number,
  hold: number,
  fade: number,
): JointSpec => ({ kind: 'hinge', parent, child, tip, bend, min, max, hold, fade });

const JOINTS: readonly JointSpec[] = [
  ball('Hips', 'Spine1', 'Spine2', [0, 0, 0.15], 0.45, 0.3, 16, 0.22),
  ball('Spine1', 'Spine2', 'Neck', [0, 0, 0.15], 0.4, 0.3, 16, 0.22),
  ball('Spine2', 'Neck', 'Head', [0, 0, 0.2], 0.55, 0.5, 14, 0.14),
  ball('Neck', 'Head', undefined, [0, 0, 0.25], 0.6, 0.6, 12, 0.14),
  ...(['Left', 'Right'] as const).flatMap((side): JointSpec[] => {
    // The character's left is +X.
    const sx = side === 'Left' ? 1 : -1;
    return [
      ball('Spine2', `${side}Arm`, `${side}ForeArm`, [0.15 * sx, 0.1, 0.6], 1.5, 1.0, 10, 0.35),
      hinge(`${side}Arm`, `${side}ForeArm`, `${side}Hand`, 1, -0.08, 2.5, 10, 0.35),
      ball(`${side}ForeArm`, `${side}Hand`, `${side}HandTip`, [0, 0, 0], 1.0, 0.3, 8, 0.35),
      ball('Hips', `${side}UpLeg`, `${side}Leg`, [0.1 * sx, 0, 0.75], 1.0, 0.5, 14, 0.08),
      hinge(`${side}UpLeg`, `${side}Leg`, `${side}Foot`, -1, -0.05, 2.4, 14, 0.08),
    ];
  }),
];

/** Residual muscle tone (rad/s) once the hold has faded. */
const TONE_REST = 2.5;
/** Natural frequency (rad/s) of the stiff spring past a joint's limit. */
const LIMIT_FREQUENCY = 32;
/** Damping of relative spin (joint friction): frequency (rad/s) and damping ratio. */
const DAMPING_FREQUENCY = 12;
const DAMPING_RATIO = 0.7;
/** Body velocities carried over from the animation are clamped to these. */
const MAX_CARRY_LINVEL = 4;
const MAX_CARRY_ANGVEL = 12;

/** Bodies that get continuous collision detection (they hit the floor hardest). */
const CCD_BONES: readonly CanonicalBone[] = ['Head', 'Spine2', 'Spine1', 'Hips'];
/**
 * Distal parts that collide with the rest of the body while limp, so arms
 * land across the chest instead of sinking into it.
 */
const SELF_COLLIDING: readonly CanonicalBone[] = ['Head', 'LeftForeArm', 'LeftHand', 'RightForeArm', 'RightHand', 'LeftLeg', 'RightLeg'];
const SELF_GROUPS = interactionGroups(
  COLLISION_GROUP.OPPONENT | COLLISION_GROUP.OPPONENT_SELF,
  COLLISION_GROUP.PLAYER | COLLISION_GROUP.STATIC | COLLISION_GROUP.OPPONENT | COLLISION_GROUP.OPPONENT_SELF,
);

/** Rest-pose geometry of a joint, in the parent/child body frames (constant per rig). */
interface JointFrames {
  readonly spec: JointSpec;
  readonly parentBone: Bone;
  readonly childBone: Bone;
  readonly parent: RAPIER.RigidBody;
  readonly child: RAPIER.RigidBody;
  /** Child segment direction, child frame. */
  readonly axisC: Vector3;
  /** Hinge: parent segment direction (where a straight child points), parent frame. Ball: swing-cone centre, parent frame. */
  readonly refP: Vector3;
  /** Hinge: anatomical bend axis, parent frame. Ball: twist reference perpendicular to the bone, child frame. */
  readonly auxC: Vector3;
  /** Ball: the same twist reference at rest, parent frame. */
  readonly auxP: Vector3;
}

interface ActiveJoint {
  readonly frames: JointFrames;
  readonly joint: RAPIER.ImpulseJoint;
  /** Parent-to-child rotation at activation (the pose the muscles hold). */
  readonly reference: Quaternion;
  /** Hinge axis in the parent frame (aligned with the knockout pose's bend). */
  readonly hingeP: Vector3;
}

interface PoseTrack {
  readonly bone: Bone;
  readonly body: RAPIER.RigidBody;
  readonly prevPos: Vector3;
  readonly prevQuat: Quaternion;
  readonly pos: Vector3;
  readonly quat: Quaternion;
}

interface SelfCollider {
  readonly collider: RAPIER.Collider;
  readonly coreGroups: number;
  /** Bodies it must not be tested against (its own and jointed neighbours). */
  readonly ignore: ReadonlySet<RAPIER.RigidBody>;
  enabled: boolean;
}

const _p = new Vector3();
const _s = new Vector3();
const _q = new Quaternion();
const _qp = new Quaternion();
const _qc = new Quaternion();
const _dev = new Quaternion();
const _frame = new Quaternion();
const _axis = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _wp = new Vector3();
const _wc = new Vector3();
const _torque = new Vector3();
const _inv = new Matrix4();
const ZERO = { x: 0, y: 0, z: 0 };
const FORWARD = new Vector3(0, 0, 1);

/** Full-body knockout ragdoll built from the opponent's hitbox bodies (Section 3). */
export class Ragdoll {
  private readonly frames: JointFrames[] = [];
  private joints: ActiveJoint[] = [];
  private readonly tracks: PoseTrack[] = [];
  private readonly selfColliders: SelfCollider[] = [];
  private readonly opponentColliders: RAPIER.Collider[] = [];
  private _active = false;
  /** Seconds since the knockout. */
  private time = 0;

  constructor(
    private readonly physics: Physics,
    private readonly rig: HumanoidRig,
    hitboxes: Hitboxes,
    rest: RestPose,
  ) {
    // Parents first (canonical order), so bones can be posed top-down.
    for (const name of CANONICAL_BONES) {
      const bone = rig.bones[name];
      const body = bone ? hitboxes.bodyFor(bone) : undefined;
      if (!bone || !body) continue;
      this.tracks.push({ bone, body, prevPos: new Vector3(), prevQuat: new Quaternion(), pos: new Vector3(), quat: new Quaternion() });
      for (let i = 0; i < body.numColliders(); i++) this.opponentColliders.push(body.collider(i));
    }

    const charPos = (name: CanonicalBone | undefined): Vector3 | null => {
      const bone = name && rig.bones[name];
      return bone ? rest.characterPosition(bone, new Vector3()) : null;
    };
    for (const spec of JOINTS) {
      const parentBone = rig.bones[spec.parent];
      const childBone = rig.bones[spec.child];
      const parent = parentBone && this.bodyOf(parentBone);
      const child = childBone && this.bodyOf(childBone);
      const pParent = charPos(spec.parent);
      const pChild = charPos(spec.child);
      if (!parentBone || !childBone || !parent || !child || !pParent || !pChild) continue;
      const qpInv = rest.characterQuaternion(parentBone, new Quaternion()).invert();
      const qcInv = rest.characterQuaternion(childBone, new Quaternion()).invert();
      const parentDir = pChild.clone().sub(pParent).normalize();
      const pTip = charPos(spec.tip);
      const childDir = pTip ? pTip.sub(pChild).normalize() : parentDir.clone();

      let refP: Vector3;
      let auxC: Vector3;
      let auxP: Vector3;
      if (spec.kind === 'hinge') {
        refP = parentDir.clone().applyQuaternion(qpInv);
        const bendAxis = new Vector3().crossVectors(parentDir, _c.set(0, 0, spec.bend));
        if (bendAxis.lengthSq() < 1e-4) bendAxis.set(spec.bend, 0, 0);
        auxC = bendAxis.normalize().applyQuaternion(qpInv);
        auxP = auxC;
      } else {
        refP = childDir.clone().add(_c.fromArray(spec.center)).normalize().applyQuaternion(qpInv);
        const perp = new Vector3().crossVectors(childDir, FORWARD);
        if (perp.lengthSq() < 1e-4) perp.set(1, 0, 0);
        perp.normalize();
        auxC = perp.clone().applyQuaternion(qcInv);
        auxP = perp.applyQuaternion(qpInv);
      }
      this.frames.push({ spec, parentBone, childBone, parent, child, axisC: childDir.applyQuaternion(qcInv), refP, auxC, auxP });
    }

    for (const name of SELF_COLLIDING) {
      const bone = rig.bones[name];
      const body = bone && this.bodyOf(bone);
      if (!body) continue;
      const ignore = new Set<RAPIER.RigidBody>([body]);
      for (const f of this.frames) {
        if (f.parent === body) ignore.add(f.child);
        if (f.child === body) ignore.add(f.parent);
      }
      for (let i = 0; i < body.numColliders(); i++) {
        const collider = body.collider(i);
        this.selfColliders.push({ collider, coreGroups: collider.collisionGroups(), ignore, enabled: false });
      }
    }
  }

  get active(): boolean {
    return this._active;
  }

  /**
   * Goes limp from the current animated pose (keeping its motion) and applies
   * the knockout blow.
   * @param impulse world impulse (N·s) applied at `point` on `struckBone`'s body
   */
  activate(struckBone: CanonicalBone, point: Vector3, impulse: Vector3): void {
    if (this._active) return;
    this._active = true;
    this.time = 0;
    const world = this.physics.world;

    for (const t of this.tracks) {
      // Kinematic bodies report the velocity of their scripted motion: carry it into the fall.
      const lv = t.body.linvel();
      const av = t.body.angvel();
      _a.set(lv.x, lv.y, lv.z).clampLength(0, MAX_CARRY_LINVEL);
      _b.set(av.x, av.y, av.z).clampLength(0, MAX_CARRY_ANGVEL);
      t.bone.matrixWorld.decompose(_p, _q, _s);
      t.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      t.body.setTranslation(_p, true);
      t.body.setRotation(_q, true);
      t.body.setLinvel(_a, true);
      t.body.setAngvel(_b, true);
      t.body.setLinearDamping(0.15);
      t.body.setAngularDamping(0.8);
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
    for (const f of this.frames) {
      // Anchor at the child bone's origin (= the child body's origin).
      f.parentBone.matrixWorld.decompose(_p, _qp, _s);
      const anchor1 = f.childBone.getWorldPosition(new Vector3()).sub(_p).applyQuaternion(_q.copy(_qp).invert());
      quat(f.parent.rotation(), _qp);
      quat(f.child.rotation(), _qc);
      const hingeP = new Vector3();
      let data: RAPIER.JointData;
      if (f.spec.kind === 'hinge') {
        // Hinge axis from the knockout pose's own bend, so the joint starts satisfied (no snap);
        // a nearly straight limb uses the anatomical axis. Oriented so flexion is positive.
        _a.copy(f.axisC).applyQuaternion(_qc);
        _b.copy(f.refP).applyQuaternion(_qp);
        _c.copy(f.auxC).applyQuaternion(_qp);
        _axis.crossVectors(_b, _a);
        if (_axis.length() > 0.15) {
          _axis.normalize();
          if (_axis.dot(_c) < 0) _axis.negate();
        } else {
          _axis.copy(_c);
        }
        hingeP.copy(_axis).applyQuaternion(_q.copy(_qp).invert());
        const hingeC = _axis.clone().applyQuaternion(_q.copy(_qc).invert());
        data = RAPIER.JointData.revolute(anchor1, ZERO, hingeP);
        data.axis1 = { x: hingeP.x, y: hingeP.y, z: hingeP.z };
        data.axis2 = { x: hingeC.x, y: hingeC.y, z: hingeC.z };
      } else {
        data = RAPIER.JointData.spherical(anchor1, ZERO);
      }
      const joint = world.createImpulseJoint(data, f.parent, f.child, true);
      joint.setContactsEnabled(false);
      const reference = _qp.clone().invert().multiply(_qc);
      this.joints.push({ frames: f, joint, reference, hingeP });
    }

    for (const s of this.selfColliders) s.enabled = false;
    this.updateSelfCollision();

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

  /** Muscle tone, joint limits and joint friction; call before each physics step. */
  beforeStep(dt: number): void {
    if (!this._active) return;
    this.time += dt;
    for (const t of this.tracks) {
      t.prevPos.copy(t.pos);
      t.prevQuat.copy(t.quat);
    }
    this.updateSelfCollision();

    for (const j of this.joints) {
      const f = j.frames;
      // Reduced inertia of the pair: the effective inertia of their relative rotation.
      const ip = meanInertia(f.parent);
      const ic = meanInertia(f.child);
      if (ip <= 0 || ic <= 0) continue; // mass properties not ready yet
      const inertia = (ip * ic) / (ip + ic);
      quat(f.parent.rotation(), _qp);
      quat(f.child.rotation(), _qc);
      _torque.set(0, 0, 0);

      // Muscle tone: hold the knockout pose, letting go over `fade` seconds.
      const tone = TONE_REST + (f.spec.hold - TONE_REST) * Math.exp(-this.time / f.spec.fade);
      _dev.copy(_qp).multiply(j.reference).invert().multiply(_qc);
      if (_dev.w < 0) _dev.set(-_dev.x, -_dev.y, -_dev.z, -_dev.w);
      const sinHalf = Math.sqrt(Math.max(0, 1 - _dev.w * _dev.w));
      if (sinHalf > 1e-6) {
        const angle = 2 * Math.acos(Math.min(1, _dev.w));
        _axis.set(_dev.x, _dev.y, _dev.z).divideScalar(sinHalf).applyQuaternion(_frame.copy(_qp).multiply(j.reference));
        _torque.addScaledVector(_axis, -tone * tone * angle);
      }

      // Anatomical limits.
      const stiff = LIMIT_FREQUENCY * LIMIT_FREQUENCY;
      _a.copy(f.axisC).applyQuaternion(_qc); // child bone direction (world)
      if (f.spec.kind === 'hinge') {
        _axis.copy(j.hingeP).applyQuaternion(_qp);
        _b.copy(f.refP).applyQuaternion(_qp); // where a straight limb would point
        const flex = signedAngle(_b, _a, _axis);
        if (flex > f.spec.max) _torque.addScaledVector(_axis, -stiff * (flex - f.spec.max));
        else if (flex < f.spec.min) _torque.addScaledVector(_axis, stiff * (f.spec.min - flex));
      } else {
        // Swing: keep the bone inside its cone.
        _b.copy(f.refP).applyQuaternion(_qp);
        const swing = Math.acos(Math.min(1, Math.max(-1, _a.dot(_b))));
        if (swing > f.spec.swing) {
          _axis.crossVectors(_a, _b);
          if (_axis.lengthSq() > 1e-8) _torque.addScaledVector(_axis.normalize(), stiff * (swing - f.spec.swing));
        }
        // Twist about the bone, measured against the parent-carried reference.
        _b.copy(f.auxP).applyQuaternion(_qp);
        _b.addScaledVector(_a, -_b.dot(_a));
        if (_b.lengthSq() > 1e-8) {
          _c.copy(f.auxC).applyQuaternion(_qc);
          const twist = signedAngle(_b.normalize(), _c, _a);
          const excess = Math.abs(twist) - f.spec.twist;
          if (excess > 0) _torque.addScaledVector(_a, -Math.sign(twist) * stiff * excess);
        }
      }
      _torque.multiplyScalar(inertia);

      // Joint friction: damp the relative spin.
      const wc = f.child.angvel();
      const wp = f.parent.angvel();
      _wc.set(wc.x, wc.y, wc.z);
      _wp.set(wp.x, wp.y, wp.z);
      _torque.addScaledVector(_wc.sub(_wp), -2 * DAMPING_RATIO * DAMPING_FREQUENCY * inertia);
      _torque.multiplyScalar(dt);
      f.child.applyTorqueImpulse(_torque, true);
      f.parent.applyTorqueImpulse(_torque.negate(), true);
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
    for (const s of this.selfColliders) {
      s.collider.setCollisionGroups(s.coreGroups);
      s.enabled = false;
    }
    for (const t of this.tracks) {
      t.body.setLinvel(ZERO, false);
      t.body.setAngvel(ZERO, false);
      t.body.enableCcd(false);
      t.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    }
  }

  /**
   * Turns on self-collision for each distal collider once it no longer
   * overlaps the rest of the body (an arm resting against the chest at the
   * knockout would otherwise be blasted apart by depenetration).
   */
  private updateSelfCollision(): void {
    for (const s of this.selfColliders) {
      if (s.enabled) continue;
      const blocked = this.opponentColliders.some((other) => {
        const body = other.parent();
        if (!body || s.ignore.has(body)) return false;
        const contact = s.collider.contactCollider(other, 0.004);
        return contact !== null && contact.distance < 0.002;
      });
      if (blocked) continue;
      s.collider.setCollisionGroups(SELF_GROUPS);
      s.enabled = true;
    }
  }

  private bodyOf(bone: Bone): RAPIER.RigidBody | undefined {
    return this.tracks.find((t) => t.bone === bone)?.body;
  }
}

function quat(r: { x: number; y: number; z: number; w: number }, out = new Quaternion()): Quaternion {
  return out.set(r.x, r.y, r.z, r.w);
}

/** Signed angle (rad) rotating unit vector `from` towards `to` about `axis`. */
function signedAngle(from: Vector3, to: Vector3, axis: Vector3): number {
  const sin = _wp.crossVectors(from, to).dot(axis);
  return Math.atan2(sin, from.dot(to));
}

/** Average principal moment of inertia (kg·m²) about the body's centre of mass. */
function meanInertia(body: RAPIER.RigidBody): number {
  const i = body.principalInertia();
  return (i.x + i.y + i.z) / 3;
}
