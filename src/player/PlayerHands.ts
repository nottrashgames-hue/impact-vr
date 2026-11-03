import {
  Euler,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type PerspectiveCamera,
  Quaternion,
  type Scene,
  Vector3,
  type XRHandSpace,
} from 'three';
import { BloodCoating } from '../blood/BloodCoating';
import { smoothstep } from '../core/mathUtils';
import type { StrikeSurface } from '../damage/Impact';
import { VelocityTracker } from '../input/VelocityTracker';
import type { Handedness, XRInput } from '../input/XRInput';
import { createFistGeometry, PLAYER_SKIN_COLOR, strikeCenterInGrip } from './FistModel';
import {
  BARE_FIST,
  type GearProfile,
  GLOVE_COLORS,
  GLOVE_TRIM_COLORS,
  type GloveColor,
  gloveProfile,
  type GloveWeight,
} from './GearProfile';
import { createGloveGeometry, gloveStrikeCenterInGrip, paintGlove } from './GloveModel';

/** How a hand is currently driven. */
export type HandDriver = 'controller' | 'hand' | 'desktop' | 'none';

/** Hand-tracking joints averaged to approximate the front knuckles. */
const KNUCKLE_JOINTS = [
  'index-finger-phalanx-proximal',
  'middle-finger-phalanx-proximal',
  'ring-finger-phalanx-proximal',
] as const;
const FINGER_TIPS = ['index-finger-tip', 'middle-finger-tip', 'ring-finger-tip', 'pinky-finger-tip'] as const;

/** Fist pose relative to the desktop camera (a loose boxing guard). */
const DESKTOP_GUARD: Record<Handedness, { position: Vector3; rotation: Quaternion }> = {
  right: { position: new Vector3(0.15, -0.16, -0.42), rotation: guardRotation(1) },
  left: { position: new Vector3(-0.16, -0.14, -0.46), rotation: guardRotation(-1) },
};

/**
 * Grip space rotated so the fist faces forward with the thumb up (+90° about X),
 * twisted thumb-in (roll), tilted so the forearm drops towards the elbow
 * (pitch), then angled slightly inwards (yaw) — a relaxed guard.
 */
function guardRotation(sign: number): Quaternion {
  const base = new Quaternion().setFromEuler(new Euler(Math.PI / 2, 0, 0));
  const roll = new Quaternion().setFromEuler(new Euler(0, 0, 0.3 * sign));
  const pitch = new Quaternion().setFromEuler(new Euler(0.75, 0, 0));
  const yaw = new Quaternion().setFromEuler(new Euler(0, 0.18 * sign, 0));
  return yaw.multiply(pitch).multiply(roll).multiply(base);
}

/** Desktop click-punch timing (Section 12): constant-speed extension, short hold, eased retract. */
const PUNCH_HOLD = 0.04;
const PUNCH_RETRACT = 0.2;
const PUNCH_OVERSHOOT = 0.03;
const FIST_FRONT = new Vector3(0, -1, 0); // grip space: the punching face points along -Y
/** Thumb-to-index distance (m) that counts as a pinch (hand-tracking grab). */
const PINCH_ON = 0.02;
const PINCH_OFF = 0.035;

const _m = new Matrix4();
const _v = new Vector3();
const _w = new Vector3();
const _bob = new Vector3();
const _one = new Vector3(1, 1, 1);
const _pos = new Vector3();
const _scale = new Vector3();
const _q = new Quaternion();
const _qPunch = new Quaternion();
const _palm = new Vector3();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _a = new Vector3();
const _b = new Vector3();

interface DesktopPunch {
  readonly from: Vector3;
  readonly to: Vector3;
  readonly direction: Vector3;
  readonly speed: number;
  readonly extendTime: number;
  t: number;
}

/** Per-hand state: the visible fist or glove, its strike sphere, velocity and blood. */
export class PlayerHand {
  readonly fist: Mesh;
  readonly glove: Mesh;
  /** World-space centre of the strike sphere, updated every frame. */
  readonly strikePoint = new Vector3();
  /** Smoothed over the last ~5 frames (Section 4). */
  readonly velocity = new VelocityTracker(5);
  /** World matrix of the visible fist/glove (grip space) this frame. */
  readonly gripMatrix = new Matrix4();
  /** Blood carried on this fist or glove (Section 7.5). */
  readonly coating = new BloodCoating();
  driver: HandDriver = 'none';
  /** Closed fist or open hand (only hand tracking can be open). */
  surface: StrikeSurface = 'fist';
  /** 0 = open, 1 = tight fist (hand tracking). */
  closedness = 1;
  pinching = false;
  /**
   * Exact velocity to use instead of the tracker (desktop click-punches,
   * whose scripted motion is too short for the smoothing window).
   */
  velocityOverride: Vector3 | null = null;
  /** Highest speed seen in the last {@link PEAK_HOLD} seconds (for the HUD). */
  recentPeakSpeed = 0;
  private recentPeakTime = 0;
  private strikeInGrip: Vector3;
  private _gear: GearProfile = BARE_FIST;
  private _gloveColor: GloveColor | null = null;
  private gloveWeight: GloveWeight = 12;
  punch: DesktopPunch | null = null;

  static readonly PEAK_HOLD = 1.5;

  constructor(readonly side: Handedness) {
    // Colours (skin tones, glove colour and trim, crease shading) are baked into the vertex colours.
    const skin = new MeshStandardMaterial({ name: `player-skin-${side}`, vertexColors: true, roughness: 0.58, metalness: 0 });
    this.coating.attach(skin);
    this.fist = new Mesh(createFistGeometry(side), skin);
    this.fist.name = `fist-${side}`;
    // Glossy leather.
    const gloveMaterial = new MeshStandardMaterial({ name: `glove-${side}`, vertexColors: true, roughness: 0.3, metalness: 0 });
    this.coating.attach(gloveMaterial);
    this.glove = new Mesh(createGloveGeometry(side, this.gloveWeight), gloveMaterial);
    this.glove.name = `glove-${side}`;
    for (const mesh of [this.fist, this.glove]) {
      mesh.castShadow = true;
      mesh.renderOrder = -2; // nearest opaque geometry: draw first for early-Z
      mesh.matrixAutoUpdate = false; // driven from tracked/camera matrices each frame
      mesh.visible = false;
    }
    this.strikeInGrip = strikeCenterInGrip(side);
  }

  get gear(): GearProfile {
    return this._gear;
  }

  /** Colour of the worn glove, or null for a bare fist. */
  get gloveColor(): GloveColor | null {
    return this._gloveColor;
  }

  /** Strike-sphere centre in grip space for the current gear. */
  get strikeOffset(): Vector3 {
    return this.strikeInGrip;
  }

  /** True when the hand has a valid pose this frame. */
  get tracked(): boolean {
    return this.driver !== 'none';
  }

  /** Velocity used for impacts: the desktop override if set, else the tracker's. */
  get impactVelocity(): Vector3 {
    return this.velocityOverride ?? this.velocity.velocity;
  }

  /** The mesh currently representing this hand (glove or bare fist). */
  get activeMesh(): Mesh {
    return this._gloveColor ? this.glove : this.fist;
  }

  /** Puts on (colour) or takes off (null) a glove. */
  setGlove(color: GloveColor | null, weight: GloveWeight): void {
    if (weight !== this.gloveWeight) {
      this.glove.geometry.dispose();
      this.glove.geometry = createGloveGeometry(this.side, weight);
      this.gloveWeight = weight;
    }
    if (color !== this._gloveColor) this.coating.clear(); // fresh glove / bare knuckles
    this._gloveColor = color;
    if (color) paintGlove(this.glove.geometry, GLOVE_COLORS[color], GLOVE_TRIM_COLORS[color]);
    this._gear = color ? gloveProfile(weight) : BARE_FIST;
    this.strikeInGrip = color ? gloveStrikeCenterInGrip(this.side) : strikeCenterInGrip(this.side);
    this.fist.visible = false;
    this.glove.visible = false;
  }

  /** Places the fist/glove from a world matrix (grip space) and samples velocity. */
  setFromGripMatrix(world: Matrix4, time: number): void {
    this.gripMatrix.copy(world);
    const mesh = this.activeMesh;
    mesh.matrix.copy(world);
    mesh.matrixWorldNeedsUpdate = true;
    mesh.visible = true;
    (mesh === this.glove ? this.fist : this.glove).visible = false;
    this.strikePoint.copy(this.strikeInGrip).applyMatrix4(world);
    this.sample(time);
  }

  /** Bare tracked hand: strike point from joints; the articulated hand mesh is shown instead. */
  setFromJoints(point: Vector3, time: number): void {
    this.fist.visible = false;
    this.glove.visible = false;
    this.strikePoint.copy(point);
    this.sample(time);
  }

  lost(): void {
    this.fist.visible = false;
    this.glove.visible = false;
    this.driver = 'none';
    this.velocity.reset();
  }

  /** World point -> local space of the visible fist/glove mesh (for blood coating). */
  worldToMesh(world: Vector3, out: Vector3): Vector3 {
    return out.copy(world).applyMatrix4(_m.copy(this.gripMatrix).invert());
  }

  private sample(time: number): void {
    this.velocity.push(this.strikePoint, time);
    const speed = this.impactVelocity.length();
    if (speed >= this.recentPeakSpeed || time - this.recentPeakTime > PlayerHand.PEAK_HOLD) {
      this.recentPeakSpeed = speed;
      this.recentPeakTime = time;
    }
  }
}

/**
 * The player's two hands. In VR each hand follows its controller grip (shown
 * as a bare fist or a glove) or the tracked hand (articulated hand mesh, or a
 * glove worn over it), switching automatically. On desktop the fists hang in
 * front of the camera and can throw scripted punches at a clicked point.
 */
export class PlayerHands {
  readonly left = new PlayerHand('left');
  readonly right = new PlayerHand('right');
  private lastTime = -1;
  private readonly grabListeners: Array<(side: Handedness) => void> = [];

  constructor(
    scene: Scene,
    private readonly camera: PerspectiveCamera,
    private readonly input: XRInput,
  ) {
    const handSkin = new MeshStandardMaterial({ name: 'player-tracked-hand', color: PLAYER_SKIN_COLOR, roughness: 0.62 });
    input.setHandMaterial(handSkin);
    for (const hand of this.both) scene.add(hand.fist, hand.glove);
  }

  get both(): readonly [PlayerHand, PlayerHand] {
    return [this.left, this.right];
  }

  get(side: Handedness): PlayerHand {
    return side === 'left' ? this.left : this.right;
  }

  /** Fired when a tracked hand pinches (hand-tracking grab; controllers use the grip button). */
  onPinch(listener: (side: Handedness) => void): void {
    this.grabListeners.push(listener);
  }

  /** Clears velocity history, e.g. after a recenter teleports the rig. */
  resetTracking(): void {
    for (const hand of this.both) {
      hand.velocity.reset();
      hand.punch = null;
      hand.velocityOverride = null;
    }
  }

  /** Desktop: throws a straight punch from the guard to a world point at `speed` m/s. */
  startDesktopPunch(side: Handedness, target: Vector3, speed: number): void {
    const hand = this.get(side);
    const from = hand.strikePoint.clone();
    const direction = target.clone().sub(from);
    const distance = direction.length();
    if (distance < 0.05) return;
    direction.divideScalar(distance);
    const to = target.clone().addScaledVector(direction, PUNCH_OVERSHOOT);
    hand.punch = { from, to, direction, speed, extendTime: (distance + PUNCH_OVERSHOOT) / speed, t: 0 };
  }

  update(time: number, inXR: boolean, dryingSpeed: number): void {
    const dt = this.lastTime < 0 ? 0 : Math.min(0.1, time - this.lastTime);
    this.lastTime = time;
    for (const hand of this.both) {
      hand.coating.update(dt, dryingSpeed);
      if (inXR) {
        hand.punch = null;
        hand.velocityOverride = null;
        this.updateXR(hand, time);
      } else {
        this.updateDesktop(hand, time, dt);
      }
    }
  }

  private updateXR(hand: PlayerHand, time: number): void {
    const slot = this.input.slotFor(hand.side);
    const mode = this.input.modeOf(hand.side);
    if (!slot || !mode) {
      hand.lost();
      return;
    }

    if (hand.driver !== mode) {
      hand.velocity.reset(); // the strike point jumps when switching drivers
      hand.driver = mode;
    }

    if (mode === 'controller') {
      if (!slot.grip.visible) {
        hand.lost();
        return;
      }
      hand.surface = 'fist';
      hand.closedness = 1;
      slot.grip.updateWorldMatrix(true, false);
      hand.setFromGripMatrix(slot.grip.matrixWorld, time);
      return;
    }

    // Hand tracking.
    const joints = slot.hand.joints;
    for (const joint of Object.values(joints)) joint?.updateWorldMatrix(true, false);
    this.updatePinch(hand, joints);
    this.updateFistClosure(hand, joints);
    const gloved = hand.gloveColor !== null;
    this.input.setHandModelVisible(hand.side, !gloved);

    if (gloved) {
      // A glove hides the fingers: drive it like a controller grip built from the joints.
      if (!this.gripFromJoints(hand.side, joints, _m)) {
        hand.lost();
        return;
      }
      hand.surface = 'fist'; // a gloved hand always lands as a punch
      hand.setFromGripMatrix(_m, time);
      return;
    }

    // Bare hand: strike point = average of the proximal finger joints.
    _v.set(0, 0, 0);
    let found = 0;
    for (const name of KNUCKLE_JOINTS) {
      const joint = joints[name];
      if (joint?.visible) {
        _v.add(_w.setFromMatrixPosition(joint.matrixWorld));
        found++;
      }
    }
    if (found === 0) {
      hand.lost();
      return;
    }
    // Keep a grip-like frame too, so blood on a bare tracked hand has somewhere to live.
    if (this.gripFromJoints(hand.side, joints, _m)) hand.gripMatrix.copy(_m);
    hand.setFromJoints(_v.multiplyScalar(1 / found), time);
  }

  /**
   * Approximates the WebXR grip space from hand joints: +Y back along the
   * forearm, -Z towards the thumb side, +X out of the back of the right hand.
   */
  private gripFromJoints(side: Handedness, joints: XRHandSpace['joints'], out: Matrix4): boolean {
    const wrist = joints.wrist;
    const middle = joints['middle-finger-phalanx-proximal'];
    const index = joints['index-finger-phalanx-proximal'];
    const pinky = joints['pinky-finger-phalanx-proximal'];
    if (!wrist?.visible || !middle?.visible || !index?.visible || !pinky?.visible) return false;
    const w = _a.setFromMatrixPosition(wrist.matrixWorld);
    const m = _b.setFromMatrixPosition(middle.matrixWorld);
    _y.subVectors(w, m).normalize();
    _z.setFromMatrixPosition(pinky.matrixWorld).sub(_w.setFromMatrixPosition(index.matrixWorld));
    _z.addScaledVector(_y, -_z.dot(_y)).normalize();
    _x.crossVectors(_y, _z);
    out.makeBasis(_x, _y, _z);
    // Origin: in the curl of the fingers, a little towards the palm.
    _pos.copy(m).lerp(w, 0.3).addScaledVector(_x, side === 'right' ? -0.02 : 0.02);
    out.setPosition(_pos);
    return true;
  }

  private updatePinch(hand: PlayerHand, joints: XRHandSpace['joints']): void {
    const thumb = joints['thumb-tip'];
    const index = joints['index-finger-tip'];
    if (!thumb?.visible || !index?.visible) return;
    const d = _a.setFromMatrixPosition(thumb.matrixWorld).distanceTo(_b.setFromMatrixPosition(index.matrixWorld));
    if (!hand.pinching && d < PINCH_ON) {
      hand.pinching = true;
      for (const listener of this.grabListeners) listener(hand.side);
    } else if (hand.pinching && d > PINCH_OFF) {
      hand.pinching = false;
    }
  }

  /**
   * Closed fist = fingertips curled in towards the palm (Section 4). Hysteresis
   * avoids flickering between punch and slap mid-swing.
   */
  private updateFistClosure(hand: PlayerHand, joints: XRHandSpace['joints']): void {
    const wrist = joints.wrist;
    const knuckle = joints['middle-finger-phalanx-proximal'];
    if (!wrist?.visible || !knuckle?.visible) return;
    _palm.setFromMatrixPosition(wrist.matrixWorld).add(_w.setFromMatrixPosition(knuckle.matrixWorld)).multiplyScalar(0.5);
    let curl = 0;
    let count = 0;
    for (const name of FINGER_TIPS) {
      const tip = joints[name];
      if (!tip?.visible) continue;
      curl += smoothstep(0.11, 0.065, _w.setFromMatrixPosition(tip.matrixWorld).distanceTo(_palm));
      count++;
    }
    if (count === 0) return;
    hand.closedness = curl / count;
    if (hand.closedness > 0.65) hand.surface = 'fist';
    else if (hand.closedness < 0.45) hand.surface = 'openHand';
  }

  private updateDesktop(hand: PlayerHand, time: number, dt: number): void {
    hand.driver = 'desktop';
    hand.surface = 'fist';
    const guard = DESKTOP_GUARD[hand.side];
    // Gentle idle bob so the hands feel alive.
    const phase = hand.side === 'left' ? 0 : 1.7;
    _bob.set(0, Math.sin(time * 1.6 + phase) * 0.006, Math.sin(time * 0.9 + phase) * 0.004);
    _m.compose(_v.copy(guard.position).add(_bob), guard.rotation, _one);
    this.camera.updateWorldMatrix(true, false);
    _m.premultiply(this.camera.matrixWorld);

    hand.velocityOverride = null;
    const punch = hand.punch;
    if (punch) {
      punch.t += dt;
      this.applyPunchPose(hand, punch, _m);
      if (punch.t >= punch.extendTime + PUNCH_HOLD + PUNCH_RETRACT) hand.punch = null;
    }
    hand.setFromGripMatrix(_m, time);
  }

  /** Overrides the guard matrix with the punch trajectory (strike centre moves along the line). */
  private applyPunchPose(hand: PlayerHand, punch: DesktopPunch, guardMatrix: Matrix4): void {
    guardMatrix.decompose(_pos, _q, _scale);
    const strikeInGrip = hand.strikeOffset;
    const guardStrike = _w.copy(strikeInGrip).applyMatrix4(guardMatrix);

    // Where along the path the strike centre is, and how far the fist has turned to face the target.
    let along: number;
    let blend: number;
    if (punch.t < punch.extendTime + PUNCH_HOLD) {
      along = Math.min(1, punch.t / punch.extendTime);
      blend = 1;
      // Keep the exact velocity through the hold too: the frame that reaches the
      // target usually ends inside the hold window, and that's when contact happens.
      hand.velocityOverride = punch.direction.clone().multiplyScalar(punch.speed);
    } else {
      const r = (punch.t - punch.extendTime - PUNCH_HOLD) / PUNCH_RETRACT;
      along = 1 - smoothstep(0, 1, r);
      blend = along;
    }
    // Strike centre: from the punch's start point, then back to the live guard position.
    const startPoint = blend < 1 ? guardStrike : punch.from;
    const strike = _v.copy(startPoint).lerp(punch.to, along);

    // Turn the fist so its punching face points along the punch.
    const front = FIST_FRONT.clone().applyQuaternion(_q);
    _qPunch.setFromUnitVectors(front, punch.direction).multiply(_q);
    _q.slerp(_qPunch, Math.min(1, blend * 1.5));
    // Shift so the strike centre lands on the path.
    const offset = _w.copy(strikeInGrip).applyQuaternion(_q);
    _pos.copy(strike).sub(offset);
    guardMatrix.compose(_pos, _q, _one);
  }
}
