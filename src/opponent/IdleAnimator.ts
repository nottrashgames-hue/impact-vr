import { type Bone, Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { clamp } from '../core/mathUtils';
import type { HitReactions } from './HitReactions';
import type { HumanoidRig, RestPose } from './HumanoidRig';
import { aimBone, rotateWorld, setWorldQuaternion, solveTwoBone } from './IK';
import { LID_CLOSE_DELTA } from './procedural/BodyLayout';

type Side = 'Left' | 'Right';

interface LimbSetup {
  readonly upper: Bone;
  readonly lower: Bone;
  readonly end: Bone;
  readonly upperAxis: Vector3;
  readonly lowerAxis: Vector3;
}

export interface HandOverride {
  readonly target: Vector3;
  weight: number;
  /** World direction the fingers (glove) point; zero = the guard's. */
  readonly aim: Vector3;
  /** World direction the elbow bends towards; zero = the guard's. */
  readonly pole: Vector3;
}

/** A foot is planted (t < 0) or stepping from `from` to its desired spot (t in 0..1). */
interface FootState {
  readonly planted: Vector3;
  readonly from: Vector3;
  t: number;
}

/** A foot steps once it is this far (m, 1.8 m rig) from where the drifting body wants it. */
const STEP_THRESHOLD = 0.045;
const STEP_TIME = 0.22;
const STEP_LIFT = 0.05;
/** How far the hands fall (m) when the guard drops fully. */
const GUARD_DROP = 0.18;

/** Orthodox guard stance, in character space for a 1.8 m rig (scaled by height). */
const STANCE = {
  hipsDrop: 0.05,
  /** Negative yaw turns the left (lead) side towards the player. */
  hipsYaw: -0.38,
  chestCounterYaw: 0.18,
  lean: [0.05, 0.04, 0.03] as const, // Spine, Spine1, Spine2 forward pitch
  feet: {
    Left: { ankle: new Vector3(0.14, 0, 0.15), yaw: -0.15, kneePole: new Vector3(0.3, 0, 1) },
    Right: { ankle: new Vector3(-0.12, 0, -0.2), yaw: -0.6, kneePole: new Vector3(-0.3, 0, 1) },
  },
  /** Hand targets as offsets from the chest bone's rest position, in the chest's frame. */
  hands: {
    Left: { offset: new Vector3(0.12, 0.13, 0.33), elbowPole: new Vector3(0.5, -1, -0.3), aim: new Vector3(0.05, 0.8, 0.6) },
    Right: { offset: new Vector3(-0.13, 0.17, 0.21), elbowPole: new Vector3(-0.5, -1, -0.3), aim: new Vector3(-0.05, 0.85, 0.5) },
  },
} as const;

const BREATH_PERIOD = 3.6;
const SWAY_PERIOD = 5.3;
const EYE_YAW_LIMIT = 0.45;
const EYE_PITCH_LIMIT = 0.3;
const HEAD_YAW_LIMIT = 0.9;
const HEAD_PITCH_LIMIT = 0.5;

const FORWARD = new Vector3(0, 0, 1);
const UP = new Vector3(0, 1, 0);
const _v = new Vector3();
const _w = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _rootQ = new Quaternion();
const _bodyQ = new Quaternion();
const _bodyInv = new Quaternion();
const _headFrame = new Quaternion();
const _headFrameInv = new Quaternion();
const _e = new Euler();
const _chest = new Matrix4();
const _stepTo = new Vector3();
const _u = new Vector3();
/** Share of the torso twist / lean / roll taken by the hips, Spine, Spine1 and Spine2. */
const TORSO_SHARE = [0.3, 0.15, 0.25, 0.3] as const;

/**
 * Procedural idle (Section 3 "Pose & behavior"): guard stance with planted feet
 * (leg IK), hands held up relative to the chest (arm IK), breathing, weight
 * shifting, blinking with saccades, and head/eye tracking of the player.
 * Every frame starts from the rest pose so nothing drifts.
 */
export class IdleAnimator {
  private readonly s: number;
  private readonly legs: Record<Side, LimbSetup>;
  private readonly arms: Record<Side, LimbSetup>;
  private readonly handTipAxis: Partial<Record<Side, Vector3>> = {};
  private readonly forwardAxis = new Map<Bone, Vector3>();
  private readonly ankleRestY: number;
  private readonly chestRestInverse = new Matrix4();
  private readonly chestRestPos = new Vector3();

  private nextBlink = 2;
  private blinkStart = -1;
  private doubleBlink = false;
  private nextSaccade = 0.5;
  private readonly saccade = new Vector3();
  private breathPhase = 0;
  private lastTime = -1;
  private readonly feet: Record<Side, FootState>;
  /** Per-eye closure from swelling (0..1); a nearly shut eye stops tracking (Section 8.3). */
  readonly eyeClosure: Record<Side, number> = { Left: 0, Right: 0 };
  /** AI hooks (OpponentBrain): 0..1 high guard covering the face. */
  guardRaise = 0;
  /**
   * AI hooks: per-hand world-space IK target override (punches, blocks, parries), blended
   * by weight, with optional world directions for the glove (fingers) and the elbow pole.
   */
  readonly handOverride: Record<Side, HandOverride> = {
    Left: { target: new Vector3(), weight: 0, aim: new Vector3(), pole: new Vector3() },
    Right: { target: new Vector3(), weight: 0, aim: new Vector3(), pole: new Vector3() },
  };
  /**
   * AI hooks: upper-body rotation on top of the stance (radians): twist (+ brings the
   * right shoulder forward), forward lean, and roll (+ tips the head to his right).
   */
  readonly torso = { twist: 0, lean: 0, roll: 0 };
  /** AI hooks: extra hip offset in character space (leaning into a jab); the feet stay put. */
  readonly extraOffset = new Vector3();

  constructor(
    private readonly rig: HumanoidRig,
    private readonly rest: RestPose,
    private readonly reactions: HitReactions,
  ) {
    this.s = rig.height / 1.8;
    const b = rig.bones;
    const limb = (upper: Bone, lower: Bone, end: Bone): LimbSetup => ({
      upper,
      lower,
      end,
      upperAxis: lower.position.clone().normalize(),
      lowerAxis: end.position.clone().normalize(),
    });
    this.legs = { Left: limb(b.LeftUpLeg, b.LeftLeg, b.LeftFoot), Right: limb(b.RightUpLeg, b.RightLeg, b.RightFoot) };
    this.arms = { Left: limb(b.LeftArm, b.LeftForeArm, b.LeftHand), Right: limb(b.RightArm, b.RightForeArm, b.RightHand) };
    if (b.LeftHandTip) this.handTipAxis.Left = b.LeftHandTip.position.clone().normalize();
    if (b.RightHandTip) this.handTipAxis.Right = b.RightHandTip.position.clone().normalize();

    // Each bone's local axis that points along character +Z in the rest pose.
    for (const bone of [b.Neck, b.Head, b.LeftEye, b.RightEye]) {
      if (!bone) continue;
      rest.characterQuaternion(bone, _q).invert();
      this.forwardAxis.set(bone, FORWARD.clone().applyQuaternion(_q));
    }
    this.ankleRestY = rest.characterPosition(b.LeftFoot, _v).y;
    this.chestRestInverse.copy(rest.characterMatrix(b.Spine2)).invert();
    rest.characterPosition(b.Spine2, this.chestRestPos);
    const foot = (side: Side): FootState => {
      const p = STANCE.feet[side].ankle.clone().multiplyScalar(this.s).setY(this.ankleRestY);
      return { planted: p, from: p.clone(), t: -1 };
    };
    this.feet = { Left: foot('Left'), Right: foot('Right') };
  }

  /**
   * The root moved by `delta` (character space) and turned by `yaw` about its
   * origin: re-express the planted feet so they stay where they are in the world.
   */
  rebaseFeet(delta: Vector3, yaw: number): void {
    for (const side of ['Left', 'Right'] as const) {
      const foot = this.feet[side];
      foot.planted.sub(delta).applyAxisAngle(UP, -yaw);
      foot.from.sub(delta).applyAxisAngle(UP, -yaw);
    }
  }

  /** Restarts timers and re-plants the feet (e.g. on opponent reset). */
  reset(): void {
    this.nextBlink = 1.5;
    this.blinkStart = -1;
    this.nextSaccade = 0.5;
    this.saccade.set(0, 0, 0);
    for (const side of ['Left', 'Right'] as const) {
      this.feet[side].planted.copy(STANCE.feet[side].ankle).multiplyScalar(this.s).setY(this.ankleRestY);
      this.feet[side].t = -1;
    }
  }

  /**
   * @param time    seconds
   * @param lookAt  world-space point the opponent watches (the player's head)
   * @param fatigue 0..1, speeds up and deepens breathing
   */
  update(time: number, lookAt: Vector3, fatigue = 0): void {
    const { rig, rest, s, reactions } = this;
    const b = rig.bones;
    const root = rig.root;
    const dt = this.lastTime < 0 ? 0 : Math.min(0.1, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    rest.restore();
    root.updateMatrixWorld(true);
    root.getWorldQuaternion(_rootQ);

    // Breathing gets faster and deeper as damage accumulates.
    this.breathPhase += (dt * 2 * Math.PI) / (BREATH_PERIOD - 1.6 * fatigue);
    const breath = Math.sin(this.breathPhase) * (1 + 1.5 * fatigue);
    const sway = Math.sin((2 * Math.PI * time) / SWAY_PERIOD);

    // Hips: lowered into the stance, swaying, turned side-on, plus hit stagger / knee buckle.
    rest.characterPosition(b.Hips, _v);
    _v.x += 0.014 * s * sway + reactions.bodyOffset.x + this.extraOffset.x;
    _v.y += -STANCE.hipsDrop * s + 0.004 * s * breath + reactions.hipDrop + this.extraOffset.y;
    _v.z += 0.008 * s * Math.sin((2 * Math.PI * time) / 7.1 + 1) + reactions.bodyOffset.z + this.extraOffset.z;
    root.localToWorld(_v);
    b.Hips.position.copy(b.Hips.parent ? b.Hips.parent.worldToLocal(_v) : _v);
    _bodyQ.copy(_rootQ).multiply(_q.setFromEuler(_e.set(0, STANCE.hipsYaw + TORSO_SHARE[0] * this.torso.twist, 0)));
    _q.copy(_bodyQ).multiply(_q2.setFromEuler(_e.set(0, 0, 0.02 * sway)));
    setWorldQuaternion(b.Hips, _q.multiply(rest.characterQuaternion(b.Hips, _q2)));
    _bodyInv.copy(_bodyQ).invert();

    // Spine: forward lean, chest counter-rotation, breathing.
    const spine = [b.Spine, b.Spine1, b.Spine2];
    for (let i = 0; i < spine.length; i++) {
      const bone = spine[i];
      if (!bone) continue;
      const share = TORSO_SHARE[i + 1];
      const pitch = STANCE.lean[i] - (i > 0 ? 0.015 * breath : 0) + share * this.torso.lean;
      const yaw = (i === 2 ? STANCE.chestCounterYaw : 0) + share * this.torso.twist;
      this.rotateInBodyFrame(bone, pitch, yaw, share * this.torso.roll);
    }
    for (const [bone, sign] of [
      [b.LeftShoulder, 1],
      [b.RightShoulder, -1],
    ] as const) {
      if (bone) this.rotateInBodyFrame(bone, 0, 0, 0.02 * sign * breath);
    }

    // Legs: planted feet that step to follow the body when it drifts.
    this.updateSteps(dt);
    for (const side of ['Left', 'Right'] as const) {
      const foot = STANCE.feet[side];
      const leg = this.legs[side];
      this.footTarget(side, _v);
      root.localToWorld(_v);
      _w.copy(foot.kneePole).applyQuaternion(_rootQ);
      solveTwoBone(leg.upper, leg.lower, leg.end, _v, _w, leg.upperAxis, leg.lowerAxis);
      _q.copy(_rootQ).multiply(_q2.setFromEuler(_e.set(0, foot.yaw, 0)));
      setWorldQuaternion(leg.end, _q.multiply(rest.characterQuaternion(leg.end, _q2)));
    }

    // Arms: guard relative to the (moving) chest.
    _chest.multiplyMatrices(b.Spine2.matrixWorld, this.chestRestInverse);
    for (const side of ['Left', 'Right'] as const) {
      const hand = STANCE.hands[side];
      const arm = this.arms[side];
      const phase = side === 'Left' ? 0 : 2.1;
      _v.copy(hand.offset)
        .multiplyScalar(s)
        .add(this.chestRestPos);
      _v.x += 0.008 * s * Math.sin(1.3 * time + phase);
      _v.y += 0.01 * s * Math.sin(1.7 * time + phase) - GUARD_DROP * s * reactions.guardDrop;
      _v.z -= 0.08 * s * reactions.guardDrop;
      // High guard: gloves up beside the face and drawn in towards the centre line.
      _v.y += 0.09 * s * this.guardRaise;
      _v.z -= 0.05 * s * this.guardRaise;
      _v.x -= Math.sign(hand.offset.x) * 0.04 * s * this.guardRaise;
      _v.applyMatrix4(_chest);
      const override = this.handOverride[side];
      const w = Math.min(1, override.weight);
      if (w > 0) _v.lerp(override.target, w);
      _w.copy(hand.elbowPole).transformDirection(_chest);
      if (w > 0 && override.pole.lengthSq() > 0) _w.lerp(_u.copy(override.pole).normalize(), w).normalize();
      solveTwoBone(arm.upper, arm.lower, arm.end, _v, _w, arm.upperAxis, arm.lowerAxis);
      const tip = this.handTipAxis[side];
      if (tip) {
        _w.copy(hand.aim).transformDirection(_chest);
        if (w > 0 && override.aim.lengthSq() > 0) _w.lerp(_u.copy(override.aim).normalize(), w).normalize();
        aimBone(arm.end, tip, _w);
      }
    }

    this.updateHeadAndEyes(time, lookAt);
    // Physical hit reactions ride on top of the finished animated pose.
    reactions.apply();
    this.updateFace(time, breath);
  }

  /** Current ankle target in character space (planted, or mid-step). */
  private footTarget(side: Side, out: Vector3): Vector3 {
    const foot = this.feet[side];
    if (foot.t < 0) return out.copy(foot.planted);
    this.desiredFoot(side, _stepTo);
    const e = foot.t * foot.t * (3 - 2 * foot.t);
    out.copy(foot.from).lerp(_stepTo, e);
    out.y += STEP_LIFT * this.s * Math.sin(Math.PI * foot.t);
    return out;
  }

  /** Where a foot wants to be: its stance spot carried along by the body's drift. */
  private desiredFoot(side: Side, out: Vector3): Vector3 {
    out.copy(STANCE.feet[side].ankle).multiplyScalar(this.s).setY(this.ankleRestY);
    out.x += this.reactions.bodyOffset.x;
    out.z += this.reactions.bodyOffset.z;
    return out;
  }

  /** Starts a step for whichever foot is furthest from where it wants to be (one at a time). */
  private updateSteps(dt: number): void {
    let worst: Side | null = null;
    let worstError = STEP_THRESHOLD * this.s;
    for (const side of ['Left', 'Right'] as const) {
      const foot = this.feet[side];
      if (foot.t >= 0) {
        foot.t += dt / STEP_TIME;
        if (foot.t >= 1) {
          this.desiredFoot(side, foot.planted);
          foot.t = -1;
        }
        return; // one foot steps at a time
      }
      const error = this.desiredFoot(side, _stepTo).distanceTo(foot.planted);
      if (error > worstError) {
        worstError = error;
        worst = side;
      }
    }
    if (worst) {
      const foot = this.feet[worst];
      foot.from.copy(foot.planted);
      foot.t = 0;
    }
  }

  /** Rotation expressed in the turned body's frame (x = pitch forward, y = yaw, z = roll). */
  private rotateInBodyFrame(bone: Bone, pitch: number, yaw: number, roll: number): void {
    _q.setFromEuler(_e.set(pitch, yaw, roll));
    _q.premultiply(_bodyQ).multiply(_bodyInv);
    rotateWorld(bone, _q);
  }

  private updateHeadAndEyes(time: number, lookAt: Vector3): void {
    const b = this.rig.bones;

    // Clamp the look target to a comfortable cone in front of the character.
    b.Head.getWorldPosition(_v);
    const dir = _w.subVectors(lookAt, _v);
    _q.copy(_rootQ).invert();
    dir.applyQuaternion(_q);
    const yaw = clamp(Math.atan2(dir.x, dir.z), -HEAD_YAW_LIMIT, HEAD_YAW_LIMIT);
    const pitch = clamp(Math.atan2(dir.y, Math.hypot(dir.x, dir.z)), -HEAD_PITCH_LIMIT, HEAD_PITCH_LIMIT);
    dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).applyQuaternion(_rootQ);

    const neckAxis = b.Neck ? this.forwardAxis.get(b.Neck) : undefined;
    if (neckAxis) aimBone(b.Neck, neckAxis, dir, 0.3);
    const headAxis = this.forwardAxis.get(b.Head);
    if (headAxis) aimBone(b.Head, headAxis, dir, 0.75);

    // Saccades: small random gaze jumps.
    if (time > this.nextSaccade) {
      this.saccade.set((Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.035, 0);
      this.nextSaccade = time + 0.4 + Math.random() * 2;
    }
    // Head frame = the head's current rotation relative to its rest orientation,
    // i.e. character axes carried along by the head (x = left, y = up, z = forward).
    b.Head.getWorldQuaternion(_headFrame).multiply(_q.copy(this.rest.characterQuaternion(b.Head, _q2)).invert());
    _headFrameInv.copy(_headFrame).invert();
    for (const [eye, side] of [
      [b.LeftEye, 'Left'],
      [b.RightEye, 'Right'],
    ] as const) {
      if (!eye || this.eyeClosure[side] > 0.8) continue; // swollen shut: stays put
      const axis = this.forwardAxis.get(eye);
      if (!axis) continue;
      eye.getWorldPosition(_v);
      // Gaze in the head frame, clamped to the eye's range of motion.
      dir.subVectors(lookAt, _v).applyQuaternion(_headFrameInv);
      const ey = clamp(Math.atan2(dir.x, dir.z) + this.saccade.x, -EYE_YAW_LIMIT, EYE_YAW_LIMIT);
      const ep = clamp(Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) + this.saccade.y, -EYE_PITCH_LIMIT, EYE_PITCH_LIMIT);
      dir.set(Math.sin(ey) * Math.cos(ep), Math.sin(ep), Math.cos(ey) * Math.cos(ep)).applyQuaternion(_headFrame);
      aimBone(eye, axis, dir);
    }
  }

  private updateFace(time: number, breath: number): void {
    const b = this.rig.bones;

    // Blink scheduling: every 2–6 s, occasionally a double blink.
    if (this.blinkStart < 0 && time > this.nextBlink) {
      this.blinkStart = time;
      this.doubleBlink = Math.random() < 0.15;
    }
    let closure = 0;
    if (this.blinkStart >= 0) {
      const p = time - this.blinkStart;
      // p is briefly negative during the gap before the second of a double blink.
      closure = p < 0 ? 0 : p < 0.07 ? p / 0.07 : p < 0.11 ? 1 : Math.max(0, 1 - (p - 0.11) / 0.13);
      if (p > 0.24) {
        this.blinkStart = this.doubleBlink ? time + 0.05 : -1;
        this.doubleBlink = false;
        if (this.blinkStart < 0) this.nextBlink = time + 2 + Math.random() * 4;
      }
    }
    // Flinch: eyes squeeze shut when hit.
    closure = Math.max(closure, this.reactions.flinch);

    for (const [lid, side] of [
      [b.LeftUpperLid, 'Left'],
      [b.RightUpperLid, 'Right'],
    ] as const) {
      if (!lid) continue;
      const c = Math.max(closure, this.eyeClosure[side]);
      lid.quaternion.copy(this.rest.restLocalQuaternion(lid)).multiply(_q.setFromEuler(_e.set(c * LID_CLOSE_DELTA, 0, 0)));
    }
    for (const morph of this.rig.blinkMorphs) {
      const influences = morph.mesh.morphTargetInfluences;
      if (!influences) continue;
      influences[morph.left] = Math.max(closure, this.eyeClosure.Left);
      influences[morph.right] = Math.max(closure, this.eyeClosure.Right);
    }

    if (b.Jaw) {
      const open = 0.025 + 0.015 * (1 - breath) * 0.5;
      b.Jaw.quaternion.copy(this.rest.restLocalQuaternion(b.Jaw)).multiply(_q.setFromEuler(_e.set(open, 0, 0)));
    }
    this.rig.root.updateMatrixWorld(true);
  }
}
