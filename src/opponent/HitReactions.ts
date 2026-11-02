import { type Bone, Quaternion, Vector3 } from 'three';
import { tierIndex, type ImpactTier } from '../damage/Impact';
import type { CanonicalBone, HumanoidRig } from './HumanoidRig';
import { rotateWorld } from './IK';

/**
 * Physics-driven partial reactions (Section 3, "Hit reactions").
 *
 * Each reacting bone carries a small rotational state (angle and angular
 * velocity, world space) on top of the animated pose, integrated as a damped
 * spring that pulls it back to the animation: the struck bone and its parents
 * up the chain receive an angular impulse from the punch (lever arm × hit
 * direction × speed), swing, and settle back. The whole body also staggers
 * (a positional spring the feet step to follow), heavy head shots buckle the
 * knees, stomach shots fold the torso forward and drop the guard.
 *
 * Full ragdoll (knockout) is handled separately by Rapier rigid bodies.
 */

interface SpringDef {
  /** Stiffness (1/s²) — sets how fast the bone returns. */
  readonly k: number;
  /** Damping ratio (1 = critical). */
  readonly zeta: number;
  /** Max deflection from the animated pose (radians). */
  readonly max: number;
}

interface BoneSpring {
  readonly bone: Bone;
  readonly theta: Vector3;
  readonly omega: Vector3;
  readonly k: number;
  readonly c: number;
  readonly max: number;
}

const SPRINGS: Partial<Record<CanonicalBone, SpringDef>> = {
  Hips: { k: 60, zeta: 0.85, max: 0.2 },
  Spine: { k: 80, zeta: 0.75, max: 0.3 },
  Spine1: { k: 80, zeta: 0.75, max: 0.35 },
  Spine2: { k: 85, zeta: 0.7, max: 0.4 },
  Neck: { k: 120, zeta: 0.6, max: 0.6 },
  Head: { k: 140, zeta: 0.55, max: 0.9 },
  LeftArm: { k: 90, zeta: 0.65, max: 0.8 },
  LeftForeArm: { k: 110, zeta: 0.6, max: 0.9 },
  RightArm: { k: 90, zeta: 0.65, max: 0.8 },
  RightForeArm: { k: 110, zeta: 0.6, max: 0.9 },
};

type Region = 'head' | 'torso' | 'stomach' | 'leftArm' | 'rightArm' | 'legs';

/** Which bones react to a hit in each region, with relative weights, and the region's gain. */
const CHAINS: Readonly<Record<Region, { gain: number; bones: readonly (readonly [CanonicalBone, number])[] }>> = {
  head: { gain: 10, bones: [['Head', 1], ['Neck', 0.6], ['Spine2', 0.2], ['Spine1', 0.1], ['Spine', 0.05]] },
  torso: { gain: 4, bones: [['Spine2', 1], ['Spine1', 0.5], ['Spine', 0.3], ['Neck', 0.3], ['Head', 0.2]] },
  stomach: { gain: 3.5, bones: [['Spine1', 1], ['Spine', 0.6], ['Spine2', 0.4], ['Hips', 0.2]] },
  leftArm: { gain: 6, bones: [['LeftForeArm', 1], ['LeftArm', 0.6], ['Spine2', 0.08]] },
  rightArm: { gain: 6, bones: [['RightForeArm', 1], ['RightArm', 0.6], ['Spine2', 0.08]] },
  legs: { gain: 1.5, bones: [['Hips', 0.4], ['Spine', 0.2]] },
};

function regionOf(bone: CanonicalBone): Region {
  if (bone === 'Head' || bone === 'Neck' || bone === 'Jaw') return 'head';
  if (bone === 'Spine2') return 'torso';
  if (bone === 'Spine1' || bone === 'Spine' || bone === 'Hips') return 'stomach';
  if (bone.startsWith('LeftArm') || bone.startsWith('LeftFore') || bone.startsWith('LeftHand')) return 'leftArm';
  if (bone.startsWith('RightArm') || bone.startsWith('RightFore') || bone.startsWith('RightHand')) return 'rightArm';
  return 'legs';
}

/** Stagger impulse (m/s of body drift per m/s of punch) by tier. */
const STAGGER = [0.03, 0.13, 0.17, 0.2];
const BODY_K = 14;
const BODY_C = 2 * 0.8 * Math.sqrt(BODY_K);
const BODY_MAX = 0.32;
/** Contact pushes: spring torque per (m · m/s²), times the chain's gain. */
const PUSH_TWIST = 2;
const DROP_K = 30;
const DROP_C = 2 * 0.7 * Math.sqrt(DROP_K);

export interface ReactionInput {
  readonly bone: CanonicalBone;
  readonly point: Vector3;
  readonly direction: Vector3;
  readonly speed: number;
  readonly tier: ImpactTier;
}

const _r = new Vector3();
const _pivot = new Vector3();
const _torque = new Vector3();
const _dirChar = new Vector3();
const _axis = new Vector3();
const _q = new Quaternion();
const _rootInv = new Quaternion();
const _right = new Vector3();

export class HitReactions {
  /** Body drift in character space (x/z), followed by the hips; the feet step after it. */
  readonly bodyOffset = new Vector3();
  private readonly bodyVelocity = new Vector3();
  /** Vertical hip offset (negative = knees buckling). */
  hipDrop = 0;
  private hipDropVelocity = 0;
  /** 0..1 how far the guard has dropped (stomach shots). */
  guardDrop = 0;
  /** 0..1 eyes squeezed shut. */
  flinch = 0;
  private readonly springs: BoneSpring[] = [];
  private readonly springByBone = new Map<CanonicalBone, BoneSpring>();

  constructor(private readonly rig: HumanoidRig) {
    // Parents before children, so applying rotations in order composes correctly.
    const order: CanonicalBone[] = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm'];
    for (const name of order) {
      const def = SPRINGS[name];
      const bone = rig.bones[name];
      if (!def || !bone) continue;
      const spring: BoneSpring = {
        bone,
        theta: new Vector3(),
        omega: new Vector3(),
        k: def.k,
        c: 2 * def.zeta * Math.sqrt(def.k),
        max: def.max,
      };
      this.springs.push(spring);
      this.springByBone.set(name, spring);
    }
  }

  /** Kicks the springs for a hit (bone poses must be current). */
  applyImpact(hit: ReactionInput): void {
    const region = regionOf(hit.bone);
    const chain = CHAINS[region];
    const tier = tierIndex(hit.tier);
    // Slightly superlinear: light hits flinch, heavy hits snap.
    const strength = hit.speed * Math.sqrt(hit.speed / 5);

    for (const [name, weight] of chain.bones) {
      const spring = this.springByBone.get(name);
      if (!spring) continue;
      spring.bone.getWorldPosition(_pivot);
      _r.subVectors(hit.point, _pivot);
      _torque.crossVectors(_r, hit.direction).multiplyScalar(chain.gain * weight * strength);
      spring.omega.add(_torque);
    }

    this.rig.root.getWorldQuaternion(_rootInv).invert();
    _right.set(1, 0, 0).applyQuaternion(_q.copy(_rootInv).invert());

    if (region === 'stomach') {
      // Doubling over: fold the torso forward (about the body's left-right axis) and drop the guard.
      for (const [name, weight] of [['Spine1', 1], ['Spine2', 0.8], ['Neck', 0.5]] as const) {
        this.springByBone.get(name)?.omega.addScaledVector(_right, 0.8 * weight * hit.speed);
      }
      this.guardDrop = Math.max(this.guardDrop, 0.35 + 0.15 * tier);
    }

    // Stagger: drift away along the punch direction (character space, horizontal).
    _dirChar.copy(hit.direction).applyQuaternion(_rootInv).setY(0);
    const drift = STAGGER[tier] * hit.speed * (region === 'legs' ? 0.3 : 1);
    this.bodyVelocity.addScaledVector(_dirChar, drift);

    if (region === 'head') {
      this.flinch = 1;
      if (tier >= 2) {
        // Heavy shots buckle the knees for a moment and drop the hands a little.
        this.hipDropVelocity -= hit.speed * (tier === 3 ? 0.05 : 0.035);
        this.guardDrop = Math.max(this.guardDrop, 0.2);
      }
    } else {
      this.flinch = Math.max(this.flinch, 0.5);
    }
  }

  /**
   * Continuous contact: a glove pressing on the body (not a punch). `force` is
   * a world-space acceleration (m/s²) applied at `point` for `dt` seconds; it
   * bends the struck chain and shoves the stance, and the feet step after it.
   */
  push(bone: CanonicalBone, point: Vector3, force: Vector3, dt: number): void {
    const region = regionOf(bone);
    const chain = CHAINS[region];
    for (const [name, weight] of chain.bones) {
      const spring = this.springByBone.get(name);
      if (!spring) continue;
      spring.bone.getWorldPosition(_pivot);
      _r.subVectors(point, _pivot);
      _torque.crossVectors(_r, force).multiplyScalar(PUSH_TWIST * chain.gain * weight * dt);
      spring.omega.add(_torque);
    }
    this.rig.root.getWorldQuaternion(_rootInv).invert();
    _dirChar.copy(force).applyQuaternion(_rootInv).setY(0);
    this.bodyVelocity.addScaledVector(_dirChar, (region === 'legs' ? 0.3 : 1) * dt);
  }

  /**
   * A deliberate slip (defensive AI): shift the body sideways and roll the
   * spine and head away. `lateral` is +1 to slip towards the character's left.
   */
  dodge(lateral: number, strength: number): void {
    this.rig.root.getWorldQuaternion(_q);
    this.bodyVelocity.x += lateral * 0.75 * strength;
    _axis.set(0, 0, 1).applyQuaternion(_q); // roll about the body's forward axis
    for (const [name, weight] of [['Spine1', 0.6], ['Spine2', 0.8], ['Neck', 0.6], ['Head', 0.5]] as const) {
      // Rolling about +Z tilts the top towards -X (character's right); negate for a left slip.
      this.springByBone.get(name)?.omega.addScaledVector(_axis, -lateral * 2.2 * weight * strength);
    }
  }

  /** Fixed-step integration of all springs. */
  step(dt: number): void {
    for (const s of this.springs) {
      // ω += (-kθ - cω)·dt ; θ += ω·dt  (semi-implicit Euler)
      s.omega.addScaledVector(s.theta, -s.k * dt).multiplyScalar(Math.max(0, 1 - s.c * dt));
      s.theta.addScaledVector(s.omega, dt);
      const angle = s.theta.length();
      if (angle > s.max) {
        s.theta.multiplyScalar(s.max / angle);
        // Remove the velocity component pushing further past the limit.
        _axis.copy(s.theta).normalize();
        const outward = s.omega.dot(_axis);
        if (outward > 0) s.omega.addScaledVector(_axis, -outward);
      }
    }

    this.bodyVelocity.addScaledVector(this.bodyOffset, -BODY_K * dt).multiplyScalar(Math.max(0, 1 - BODY_C * dt));
    this.bodyOffset.addScaledVector(this.bodyVelocity, dt);
    if (this.bodyOffset.length() > BODY_MAX) this.bodyOffset.setLength(BODY_MAX);

    this.hipDropVelocity = (this.hipDropVelocity - DROP_K * this.hipDrop * dt) * Math.max(0, 1 - DROP_C * dt);
    this.hipDrop = Math.min(0.02, Math.max(-0.15, this.hipDrop + this.hipDropVelocity * dt));

    this.guardDrop *= Math.exp(-dt / 0.6);
    this.flinch = Math.max(0, this.flinch - dt * 4);
  }

  /** Adds the spring rotations on top of the animated pose (call after animation/IK). */
  apply(): void {
    for (const s of this.springs) {
      const angle = s.theta.length();
      if (angle < 1e-4) continue;
      _q.setFromAxisAngle(_axis.copy(s.theta).divideScalar(angle), angle);
      rotateWorld(s.bone, _q);
    }
  }

  reset(): void {
    for (const s of this.springs) {
      s.theta.set(0, 0, 0);
      s.omega.set(0, 0, 0);
    }
    this.bodyOffset.set(0, 0, 0);
    this.bodyVelocity.set(0, 0, 0);
    this.hipDrop = 0;
    this.hipDropVelocity = 0;
    this.guardDrop = 0;
    this.flinch = 0;
  }
}
