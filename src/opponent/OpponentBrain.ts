import { Quaternion, Vector3 } from 'three';
import type { AudioSystem } from '../audio/AudioSystem';
import { smoothstep } from '../core/mathUtils';
import type { OpponentMode } from '../core/Settings';
import type { XRInput } from '../input/XRInput';
import type { PlayerHand, PlayerHands } from '../player/PlayerHands';
import type { HitFlash } from '../ui/HitFlash';
import type { Opponent } from './Opponent';

type Side = 'Left' | 'Right';
type PunchKind = 'straight' | 'hook' | 'uppercut';

/**
 * One punch: which hand, its path, and its timing (seconds). `twist` is the
 * torso rotation it is thrown with (+ brings the right shoulder forward),
 * `lean` the weight shift into it (m), `dip` how far the knees bend (m).
 */
interface PunchDef {
  readonly hand: Side;
  readonly kind: PunchKind;
  readonly body: boolean;
  readonly chamber: number;
  readonly extend: number;
  readonly retract: number;
  readonly twist: number;
  readonly lean: number;
  readonly dip: number;
  readonly power: number;
}

const punch = (
  hand: Side, kind: PunchKind, body: boolean, chamber: number, extend: number, retract: number,
  twist: number, lean: number, dip: number, power: number,
): PunchDef => ({ hand, kind, body, chamber, extend, retract, twist, lean, dip, power });

/** Orthodox: the left hand leads. */
const PUNCHES = {
  jab: punch('Left', 'straight', false, 0.06, 0.13, 0.18, -0.14, 0.05, 0, 0.45),
  cross: punch('Right', 'straight', false, 0.09, 0.17, 0.24, 0.6, 0.09, 0.01, 1),
  leadHook: punch('Left', 'hook', false, 0.1, 0.2, 0.26, -0.55, 0.03, 0.03, 0.85),
  rearHook: punch('Right', 'hook', false, 0.11, 0.21, 0.28, 0.6, 0.04, 0.03, 0.9),
  leadUppercut: punch('Left', 'uppercut', false, 0.12, 0.19, 0.26, -0.25, 0.03, 0.08, 0.8),
  rearUppercut: punch('Right', 'uppercut', false, 0.12, 0.2, 0.28, 0.45, 0.05, 0.09, 0.9),
  bodyJab: punch('Left', 'straight', true, 0.08, 0.15, 0.2, -0.12, 0.07, 0.11, 0.4),
  bodyCross: punch('Right', 'straight', true, 0.1, 0.18, 0.26, 0.55, 0.1, 0.12, 0.8),
  leadBodyHook: punch('Left', 'hook', true, 0.1, 0.2, 0.28, -0.5, 0.03, 0.13, 0.8),
} as const;
type PunchName = keyof typeof PUNCHES;

/** Combinations he strings together; the next punch starts as the previous one comes back. */
const COMBOS: readonly (readonly PunchName[])[] = [
  ['jab'],
  ['jab', 'jab'],
  ['jab', 'cross'],
  ['jab', 'jab', 'cross'],
  ['jab', 'cross', 'leadHook'],
  ['cross', 'leadHook', 'cross'],
  ['jab', 'rearUppercut', 'leadHook'],
  ['leadUppercut', 'cross'],
  ['bodyJab', 'cross'],
  ['jab', 'bodyCross', 'leadHook'],
  ['leadBodyHook', 'leadHook'],
  ['jab', 'cross', 'leadHook', 'cross'],
  ['leadHook', 'rearHook'],
];
const COUNTERS: readonly PunchName[] = ['cross', 'leadHook', 'rearUppercut', 'jab', 'cross'];

/** Player hit volumes around the head and the chest (m). */
const HEAD_RADIUS = 0.15;
const CHEST_RADIUS = 0.19;
/** The opponent's glove radius plus a little margin; the player's strike radius is added per hand. */
const BLOCK_RADIUS = 0.09;
/** Horizontal distance (root to the player's head) he likes to fight at, and where he steps in / out. */
const RANGE_IN = 0.86;
const RANGE_OUT = 0.5;

const UP = new Vector3(0, 1, 0);
const _head = new Vector3();
const _chest = new Vector3();
const _glove = new Vector3();
const _v = new Vector3();
const _w = new Vector3();
const _rel = new Vector3();
const _fwd = new Vector3();
const _left = new Vector3();
const _rootInv = new Quaternion();

interface ActivePunch {
  readonly def: PunchDef;
  readonly name: PunchName;
  phase: 'chamber' | 'extend' | 'retract';
  t: number;
  readonly start: Vector3;
  readonly chamber: Vector3;
  readonly end: Vector3;
  readonly ctrl: Vector3;
  resolved: boolean;
}

type DefenseKind = 'block' | 'shell' | 'tuck' | 'parry';

/** A hand busy defending: where it goes is recomputed each frame against the threat. */
interface HandDefense {
  readonly kind: DefenseKind;
  readonly threat: PlayerHand;
  t: number;
  readonly duration: number;
  readonly sweep: Vector3;
}

/** A whole-body evasion (slip, duck / bob-and-weave). */
interface BodyMove {
  readonly kind: 'slip' | 'duck';
  /** +1 towards his left. */
  readonly dir: number;
  t: number;
  readonly duration: number;
}

/**
 * Opponent behaviour modes (Section 3):
 *  - passive: a training dummy that just takes hits;
 *  - defensive: high guard; reads incoming punches and blocks them on the line
 *    (glove to the forehead for straights, shell against the temple for hooks,
 *    elbow tucked over the ribs for body shots), parries, slips and ducks;
 *  - sparring: all of that, plus footwork to stay in range and real
 *    combinations (jab, cross, hooks, uppercuts, body shots) thrown with hip and
 *    shoulder rotation, and counters after a successful defence. A landed punch
 *    flashes the view and buzzes the controllers; gloves in the way block it.
 */
export class OpponentBrain {
  private mode: OpponentMode = 'passive';
  private time = 0;
  private fatigue = 0;
  private readonly punches: Record<Side, ActivePunch | null> = { Left: null, Right: null };
  private readonly defense: Record<Side, HandDefense | null> = { Left: null, Right: null };
  private body: BodyMove | null = null;
  private combo: PunchName[] = [];
  private nextAttack = 2.5;
  private counterAt = -1;
  /** Per player hand: already decided how to react to the current incoming punch. */
  private readonly decided = { left: false, right: false };
  private stunnedUntil = 0;
  private circle = 0;
  private circleUntil = 0;

  constructor(
    private readonly opponent: Opponent,
    private readonly hands: PlayerHands,
    private readonly flash: HitFlash,
    private readonly input: XRInput,
    private readonly audio: AudioSystem,
  ) {}

  setMode(mode: OpponentMode): void {
    this.mode = mode;
    this.reset();
  }

  reset(): void {
    const a = this.opponent.animator;
    a.guardRaise = 0;
    for (const side of ['Left', 'Right'] as const) {
      a.handOverride[side].weight = 0;
      this.punches[side] = null;
      this.defense[side] = null;
    }
    a.extraOffset.set(0, 0, 0);
    a.torso.twist = 0;
    a.torso.lean = 0;
    a.torso.roll = 0;
    this.body = null;
    this.combo = [];
    this.nextAttack = this.time + 2.5;
    this.counterAt = -1;
    this.decided.left = false;
    this.decided.right = false;
  }

  /**
   * @param playerHead world position of the player's head
   * @param fatigue    0..1 from the damage model: slower, rarer punches and sloppier defence
   */
  update(dt: number, playerHead: Vector3, fatigue = 0): void {
    this.time += dt;
    this.fatigue = fatigue;
    const a = this.opponent.animator;
    if (this.opponent.state !== 'standing') {
      if (a.guardRaise > 0 || this.combo.length || this.punches.Left || this.punches.Right || this.body) this.reset();
      return;
    }
    if (this.mode === 'passive') {
      a.guardRaise = Math.max(0, a.guardRaise - dt * 2);
      for (const side of ['Left', 'Right'] as const) a.handOverride[side].weight = Math.max(0, a.handOverride[side].weight - dt * 5);
      a.extraOffset.multiplyScalar(Math.max(0, 1 - dt * 6));
      a.torso.twist *= Math.max(0, 1 - dt * 6);
      a.torso.lean *= Math.max(0, 1 - dt * 6);
      a.torso.roll *= Math.max(0, 1 - dt * 6);
      return;
    }

    // A heavy shot rocks him: he stops punching for a moment.
    const r = this.opponent.reactions;
    if (r.guardDrop > 0.3 || r.hipDrop < -0.05) {
      this.stunnedUntil = this.time + 0.7 + this.fatigue;
      this.combo.length = 0;
      for (const side of ['Left', 'Right'] as const) {
        const p = this.punches[side];
        if (p && p.phase === 'chamber') this.punches[side] = null;
      }
    }

    // Guard: tight high guard when defending, a working guard when fighting.
    const busy = this.defense.Left || this.defense.Right;
    const guardGoal = busy ? 1 : this.mode === 'defensive' ? 0.9 : 0.55;
    a.guardRaise += (guardGoal - a.guardRaise) * Math.min(1, dt * (busy ? 14 : 4));

    this.opponent.rig.root.getWorldQuaternion(_rootInv);
    _fwd.set(0, 0, 1).applyQuaternion(_rootInv);
    _left.set(1, 0, 0).applyQuaternion(_rootInv);
    _rootInv.invert();
    this.opponent.rig.bones.Head.getWorldPosition(_head);
    this.opponent.rig.bones.Spine2.getWorldPosition(_chest);

    this.readThreats();
    if (this.mode === 'sparring') {
      this.footwork(dt, playerHead);
      this.attack(playerHead);
    }

    this.updatePunches(dt, playerHead);
    this.updateDefense(dt);
    this.updateBody(dt);
  }

  // --- Defence -------------------------------------------------------------------------

  /** Reads each player hand once per incoming punch and picks a defence. */
  private readThreats(): void {
    for (const hand of this.hands.both) {
      if (!hand.tracked) continue;
      _rel.subVectors(_head, hand.strikePoint);
      const distance = _rel.length();
      _rel.divideScalar(Math.max(distance, 1e-6));
      const velocity = hand.impactVelocity;
      const approach = velocity.dot(_rel);
      const incoming = distance < 0.85 && approach > 2.2;
      if (!incoming) {
        if (distance > 0.9 || approach < 0.5) this.decided[hand.side] = false;
        continue;
      }
      if (this.decided[hand.side]) continue;
      this.decided[hand.side] = true;

      // What is coming: a hook has a lot of sideways speed; a body shot comes in below the shoulders.
      _v.copy(velocity).addScaledVector(_rel, -approach);
      const hook = _v.length() > 0.75 * approach;
      const toBody = hand.strikePoint.y < _chest.y + 0.06;
      // Which of his sides it arrives on.
      const side: Side = _w.subVectors(hand.strikePoint, _head).dot(_left) > 0 ? 'Left' : 'Right';
      this.chooseDefense(hand, hook ? 'hook' : toBody ? 'body' : 'straight', side);
    }
  }

  private chooseDefense(threat: PlayerHand, kind: 'straight' | 'hook' | 'body', side: Side): void {
    const skill = 1 - 0.55 * this.fatigue;
    const other: Side = side === 'Left' ? 'Right' : 'Left';
    const free = (s: Side): boolean => !this.punches[s] || this.punches[s]?.phase === 'retract';
    const roll = Math.random();
    let defended = true;
    if (roll > 0.9 * skill) {
      defended = false; // too slow to read it: he takes it
    } else if (kind === 'body') {
      if (free(side)) this.startDefense(side, 'tuck', threat, 0.5);
      else if (free(other)) this.startDefense(other, 'tuck', threat, 0.5);
      else defended = false;
    } else if (kind === 'hook') {
      if (roll < 0.25 * skill && !this.body) this.startBody('duck', side === 'Left' ? -1 : 1, 0.55);
      else if (free(side)) this.startDefense(side, 'shell', threat, 0.5);
      else if (!this.body) this.startBody('duck', side === 'Left' ? -1 : 1, 0.55);
      else defended = false;
    } else {
      // Straight to the head: catch it on the glove, parry it aside, or slip outside it.
      if (roll < 0.18 * skill && free(other)) this.startDefense(other, 'parry', threat, 0.32);
      else if (roll < 0.38 * skill && !this.body) this.startBody('slip', side === 'Left' ? -1 : 1, 0.42);
      else if (free(side)) this.startDefense(side, 'block', threat, 0.45);
      else if (free(other)) this.startDefense(other, 'block', threat, 0.45);
      else if (!this.body) this.startBody('slip', side === 'Left' ? -1 : 1, 0.42);
      else defended = false;
    }
    if (defended && this.mode === 'sparring' && Math.random() < 0.5 && this.counterAt < 0) {
      this.counterAt = this.time + 0.18 + Math.random() * 0.15;
    }
  }

  private startDefense(side: Side, kind: DefenseKind, threat: PlayerHand, duration: number): void {
    this.punches[side] = null;
    // A parry slaps the punch across, away from the centre line.
    const sweep = _left.clone().multiplyScalar(side === 'Left' ? -0.13 : 0.13);
    this.defense[side] = { kind, threat, t: 0, duration, sweep };
  }

  private startBody(kind: 'slip' | 'duck', dir: number, duration: number): void {
    this.body = { kind, dir, t: 0, duration };
  }

  private updateDefense(dt: number): void {
    const a = this.opponent.animator;
    for (const side of ['Left', 'Right'] as const) {
      const d = this.defense[side];
      const o = a.handOverride[side];
      if (!d) {
        if (!this.punches[side]) o.weight = Math.max(0, o.weight - dt * 5);
        continue;
      }
      d.t += dt;
      const t = d.t / d.duration;
      if (t >= 1) {
        this.defense[side] = null;
        continue;
      }
      // Snap in fast, hold, ease back to the guard.
      o.weight = smoothstep(0, 0.12, t) * (1 - smoothstep(0.7, 1, t));
      const sideSign = side === 'Left' ? 1 : -1;
      const fist = d.threat.strikePoint;
      switch (d.kind) {
        case 'block':
          // Glove on the punch line just in front of the face, tight to the forehead; elbow down.
          _v.subVectors(fist, _head).setY(0).normalize();
          o.target.copy(_head).addScaledVector(_v, 0.12).addScaledVector(UP, 0.01).addScaledVector(_left, 0.025 * sideSign);
          o.aim.copy(UP).addScaledVector(_v, 0.35);
          o.pole.set(0, -1, 0).addScaledVector(_left, 0.35 * sideSign);
          break;
        case 'shell':
          // Glove against the temple, forearm vertical over the jaw, elbow tight to the ribs.
          o.target.copy(_head).addScaledVector(_left, 0.1 * sideSign).addScaledVector(_fwd, 0.05).addScaledVector(UP, 0.02);
          o.aim.copy(UP).addScaledVector(_fwd, 0.2);
          o.pole.set(0, -1, 0).addScaledVector(_fwd, 0.25);
          break;
        case 'tuck':
          // Elbow drops over the ribs on that side, glove stays at the chin.
          o.target.copy(_chest).addScaledVector(_left, 0.11 * sideSign).addScaledVector(_fwd, 0.14).addScaledVector(UP, 0.13);
          o.aim.copy(UP).addScaledVector(_fwd, 0.4);
          o.pole.set(0, -1, 0).addScaledVector(_left, 0.15 * sideSign);
          break;
        case 'parry': {
          // Meet the fist in front of the face, then slap it across.
          _v.subVectors(fist, _head);
          const reach = Math.min(0.26, _v.length() * 0.6);
          o.target.copy(_head).addScaledVector(_v.normalize(), reach).addScaledVector(d.sweep, smoothstep(0.25, 0.6, t));
          o.aim.copy(_v).addScaledVector(UP, 0.6);
          o.pole.set(0, -1, 0);
          break;
        }
      }
    }
  }

  /** Slips and ducks move the whole upper body off the line. */
  private updateBody(dt: number): void {
    const a = this.opponent.animator;
    let roll = 0;
    let lean = 0;
    let dx = 0;
    let dy = 0;
    const m = this.body;
    if (m) {
      m.t += dt;
      const t = m.t / m.duration;
      if (t >= 1) {
        this.body = null;
      } else {
        const e = Math.sin(Math.PI * Math.min(1, t * 1.15)); // in quickly, out smoothly
        if (m.kind === 'slip') {
          // Head moves outside the punch: lean to the side, knees soft.
          roll = -0.32 * m.dir * e;
          dx = 0.07 * m.dir * e;
          dy = -0.03 * e;
          lean = 0.08 * e;
        } else {
          // Bob and weave: down under the hook and across to the other side.
          dy = -0.14 * e;
          lean = 0.3 * e;
          dx = 0.07 * m.dir * Math.sin(Math.PI * (t - 0.5));
          roll = -0.12 * m.dir * Math.sin(Math.PI * (t - 0.5));
        }
      }
    }
    // Covering the body: crunch over the tucked elbow.
    let twist = 0;
    for (const side of ['Left', 'Right'] as const) {
      if (this.defense[side]?.kind !== 'tuck') continue;
      const w = a.handOverride[side].weight;
      lean += 0.15 * w;
      twist += (side === 'Left' ? 0.15 : -0.15) * w;
    }
    // Punch mechanics (rotation, weight transfer, knee bend) add on top.
    let dz = 0;
    for (const side of ['Left', 'Right'] as const) {
      const p = this.punches[side];
      if (!p) continue;
      const def = p.def;
      let k: number;
      if (p.phase === 'chamber') k = -0.25 * smoothstep(0, 1, p.t / def.chamber);
      else if (p.phase === 'extend') k = -0.25 + 1.25 * smoothstep(0, 1, p.t / def.extend);
      else k = 1 - smoothstep(0, 1, p.t / def.retract);
      const drive = Math.max(0, k);
      twist += def.twist * k;
      dz += def.lean * drive;
      dy -= def.dip * (p.phase === 'chamber' ? smoothstep(0, 1, p.t / def.chamber) : def.kind === 'uppercut' ? 1 - drive : 1 - 0.5 * drive);
      lean += (def.body ? 0.2 : 0.06) * drive;
    }
    // A little rhythm while fighting: bouncing knees and a slow weave.
    if (this.mode === 'sparring') {
      dy += 0.008 * Math.sin(this.time * 7);
      dx += 0.018 * Math.sin(this.time * 1.3);
      roll += 0.04 * Math.sin(this.time * 1.3 + 0.4);
    }
    const ease = Math.min(1, dt * 18);
    a.torso.twist += (twist - a.torso.twist) * ease;
    a.torso.lean += (lean - a.torso.lean) * ease;
    a.torso.roll += (roll - a.torso.roll) * ease;
    _v.set(dx, dy, dz);
    a.extraOffset.lerp(_v, ease);
  }

  // --- Offence -------------------------------------------------------------------------

  /** Steps in to punching range, backs off when crowded, and circles now and then. */
  private footwork(dt: number, playerHead: Vector3): void {
    const root = this.opponent.rig.root.position;
    _v.set(playerHead.x - root.x, 0, playerHead.z - root.z);
    const distance = _v.length();
    _v.divideScalar(Math.max(distance, 1e-6));
    let speed = 0;
    if (this.time > this.stunnedUntil) {
      if (distance > RANGE_IN) speed = Math.min(1.6, (distance - RANGE_IN) * 4 + 0.6);
      else if (distance < RANGE_OUT) speed = -1.2;
    }
    if (this.time > this.circleUntil) {
      this.circle = Math.random() < 0.35 ? (Math.random() < 0.5 ? -1 : 1) : 0;
      this.circleUntil = this.time + 0.6 + Math.random() * 1.6;
    }
    _w.copy(_v).multiplyScalar(speed);
    if (this.circle) _w.addScaledVector(_v.set(-_v.z, 0, _v.x), 0.7 * this.circle);
    if (_w.lengthSq() < 1e-4) return;
    this.opponent.reactions.walk(_w.applyQuaternion(_rootInv).setY(0), dt);
  }

  private attack(playerHead: Vector3): void {
    if (this.time < this.stunnedUntil) return;
    const root = this.opponent.rig.root.position;
    const distance = Math.hypot(playerHead.x - root.x, playerHead.z - root.z);
    const inRange = distance < RANGE_IN + 0.1;

    if (this.counterAt > 0 && this.time >= this.counterAt) {
      this.counterAt = -1;
      if (inRange && !this.combo.length) this.combo = [COUNTERS[Math.floor(Math.random() * COUNTERS.length)]];
    }
    if (!this.combo.length && this.time >= this.nextAttack && inRange && !this.defense.Left && !this.defense.Right) {
      this.combo = [...COMBOS[Math.floor(Math.random() * COMBOS.length)]];
    }
    if (!this.combo.length) return;

    // Next punch goes as soon as its hand is free and the previous one is on its way back.
    const name = this.combo[0];
    const def = PUNCHES[name];
    const other: Side = def.hand === 'Left' ? 'Right' : 'Left';
    const busy = this.punches[def.hand] || this.defense[def.hand];
    const previous = this.punches[other];
    if (busy || (previous && previous.phase !== 'retract')) return;
    this.combo.shift();
    this.launch(name);
    if (!this.combo.length) this.nextAttack = this.time + (1.1 + Math.random() * 1.9) * (1 + 1.5 * this.fatigue);
  }

  private launch(name: PunchName): void {
    const def = PUNCHES[name];
    const bone = this.opponent.rig.bones[`${def.hand}Hand`];
    const start = bone.getWorldPosition(new Vector3());
    // Chamber: a small, honest tell — the glove draws back towards the chin (or drops for an uppercut).
    const chamber = start.clone().addScaledVector(_fwd, -0.035);
    if (def.kind === 'uppercut') chamber.addScaledVector(UP, -0.1).addScaledVector(_fwd, -0.02);
    if (def.kind === 'hook') chamber.addScaledVector(_left, (def.hand === 'Left' ? 1 : -1) * 0.04);
    this.punches[def.hand] = { def, name, phase: 'chamber', t: 0, start, chamber, end: new Vector3(), ctrl: new Vector3(), resolved: false };
  }

  /** Fixes the punch's path at the end of the chamber, aimed at where the player is now. */
  private aim(p: ActivePunch, playerHead: Vector3): void {
    const def = p.def;
    const sideSign = def.hand === 'Left' ? 1 : -1;
    const shoulder = this.opponent.rig.bones[`${def.hand}Arm`].getWorldPosition(new Vector3());
    const target = playerHead.clone();
    if (def.body) target.addScaledVector(UP, -0.42).addScaledVector(_fwd, 0.06);
    // Human aim is not perfect.
    target.x += (Math.random() - 0.5) * 0.06;
    target.y += (Math.random() - 0.5) * 0.05;
    const reach = 0.64 * (this.opponent.rig.height / 1.8);
    _v.subVectors(target, shoulder);
    // Straights are thrown through the target; hooks and uppercuts land on it.
    const along = def.kind === 'straight' ? _v.length() + 0.06 : _v.length();
    p.end.copy(shoulder).addScaledVector(_v.normalize(), Math.min(along, reach));
    if (def.kind === 'hook') {
      // Swings around from the outside, elbow up, level with the target.
      p.ctrl.lerpVectors(p.chamber, p.end, 0.5).addScaledVector(_left, 0.3 * sideSign).addScaledVector(_fwd, 0.05);
      p.ctrl.y = p.end.y + 0.03;
    } else if (def.kind === 'uppercut') {
      // Rises from below, close to the body.
      p.ctrl.lerpVectors(p.chamber, p.end, 0.5).addScaledVector(UP, -0.18).addScaledVector(_fwd, -0.04);
    } else {
      p.ctrl.lerpVectors(p.chamber, p.end, 0.5);
    }
  }

  private updatePunches(dt: number, playerHead: Vector3): void {
    const a = this.opponent.animator;
    for (const side of ['Left', 'Right'] as const) {
      const p = this.punches[side];
      if (!p) continue;
      const o = a.handOverride[side];
      const def = p.def;
      const sideSign = side === 'Left' ? 1 : -1;
      p.t += dt;
      if (p.phase === 'chamber') {
        const t = Math.min(1, p.t / def.chamber);
        o.target.lerpVectors(p.start, p.chamber, t);
        o.weight = smoothstep(0, 0.6, t);
        o.aim.set(0, 0, 0);
        o.pole.set(0, 0, 0);
        if (p.t >= def.chamber) {
          this.aim(p, playerHead);
          p.phase = 'extend';
          p.t = 0;
        }
      } else if (p.phase === 'extend') {
        const t = Math.min(1, p.t / def.extend);
        // Fast out: accelerates then snaps to the end (quadratic Bézier through the control point).
        const e = 1 - (1 - t) * (1 - t);
        bezier(p.chamber, p.ctrl, p.end, e, o.target);
        o.weight = 1;
        if (def.kind === 'hook') {
          o.aim.subVectors(p.end, p.ctrl).addScaledVector(_left, -0.4 * sideSign);
          o.pole.copy(_left).multiplyScalar(sideSign).addScaledVector(UP, 0.9);
        } else if (def.kind === 'uppercut') {
          o.aim.subVectors(p.end, p.ctrl).addScaledVector(UP, 0.4);
          o.pole.set(0, -1, 0).addScaledVector(_fwd, -0.5);
        } else {
          o.aim.subVectors(p.end, p.chamber);
          o.pole.set(0, -1, 0).addScaledVector(_left, 0.45 * sideSign);
        }
        if (t > 0.55) this.checkContact(p, playerHead);
        if (p.t >= def.extend + 0.03) {
          p.phase = 'retract';
          p.t = 0;
        }
      } else {
        // Back along the same line into the guard.
        const t = Math.min(1, p.t / def.retract);
        o.weight = 1 - smoothstep(0, 1, t);
        if (t >= 1) this.punches[side] = null;
      }
    }
  }

  private checkContact(p: ActivePunch, playerHead: Vector3): void {
    if (p.resolved) return;
    const hand = this.opponent.rig.bones[`${p.def.hand}Hand`];
    const tip = this.opponent.rig.bones[`${p.def.hand}HandTip`];
    hand.getWorldPosition(_glove);
    if (tip) _glove.lerp(tip.getWorldPosition(_v), 0.6);
    // Caught on the player's glove or fist.
    for (const h of this.hands.both) {
      if (h.tracked && h.strikePoint.distanceTo(_glove) < BLOCK_RADIUS + h.gear.strikeRadius) {
        p.resolved = true;
        this.input.pulse(h.side, 0.35 + 0.4 * p.def.power, 45);
        this.audio.playImpact('glove', p.def.power > 0.7 ? 1 : 0, _glove);
        // Bounces off: straight into the retract.
        p.phase = 'retract';
        p.t = p.def.retract * 0.25;
        return;
      }
    }
    const target = p.def.body ? _v.copy(playerHead).addScaledVector(UP, -0.42) : _v.copy(playerHead);
    if (_glove.distanceTo(target) < (p.def.body ? CHEST_RADIUS : HEAD_RADIUS)) {
      p.resolved = true;
      const strength = (p.def.body ? 0.45 : 0.7) + 0.3 * p.def.power;
      this.flash.flash(strength);
      this.input.pulse('left', strength, 90 + 60 * p.def.power);
      this.input.pulse('right', strength, 90 + 60 * p.def.power);
      this.audio.playImpact(p.def.body ? 'body' : 'glove', p.def.power > 0.7 ? 2 : 1, playerHead);
    }
  }
}

function bezier(a: Vector3, b: Vector3, c: Vector3, t: number, out: Vector3): Vector3 {
  const u = 1 - t;
  return out.set(
    u * u * a.x + 2 * u * t * b.x + t * t * c.x,
    u * u * a.y + 2 * u * t * b.y + t * t * c.y,
    u * u * a.z + 2 * u * t * b.z + t * t * c.z,
  );
}
