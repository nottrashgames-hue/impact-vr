import { Vector3 } from 'three';
import type { AudioSystem } from '../audio/AudioSystem';
import type { OpponentMode } from '../core/Settings';
import type { XRInput } from '../input/XRInput';
import type { PlayerHands } from '../player/PlayerHands';
import type { HitFlash } from '../ui/HitFlash';
import type { Opponent } from './Opponent';

type JabPhase = 'idle' | 'windup' | 'strike' | 'retract';

const WINDUP = 0.5;
const STRIKE = 0.32;
const RETRACT = 0.45;
/** How close (m) the opponent's glove must get to the player's head to count as a hit. */
const JAB_HIT_RADIUS = 0.17;
/** The opponent's glove radius plus a little margin; the player's strike radius is added per hand. */
const BLOCK_RADIUS = 0.09;

const _head = new Vector3();
const _toHead = new Vector3();
const _glove = new Vector3();
const _v = new Vector3();
const _shoulder = new Vector3();

/**
 * Opponent behaviour modes (Section 3):
 *  - passive: a training dummy that just takes hits;
 *  - defensive: high guard, blocks some incoming punches (moves a glove into
 *    the path) and occasionally slips them;
 *  - sparring: throws slow, telegraphed jabs at the player's head. A landed
 *    jab only flashes the view and buzzes the controllers.
 */
export class OpponentBrain {
  private mode: OpponentMode = 'passive';
  /** Per player hand: already decided how to react to the current incoming punch. */
  private readonly decided = { left: false, right: false };
  private actionUntil = 0;
  private time = 0;
  private jab: JabPhase = 'idle';
  private jabTime = 0;
  private nextJab = 3;
  private jabLanded = false;
  private readonly jabTarget = new Vector3();
  private readonly jabStart = new Vector3();

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
    a.handOverride.Left.weight = 0;
    a.handOverride.Right.weight = 0;
    a.extraOffset.set(0, 0, 0);
    this.jab = 'idle';
    this.nextJab = this.time + 3;
    this.actionUntil = 0;
  }

  update(dt: number, playerHead: Vector3): void {
    this.time += dt;
    const a = this.opponent.animator;
    if (this.opponent.state !== 'standing') {
      if (a.guardRaise > 0 || this.jab !== 'idle') this.reset();
      return;
    }
    // Guard height eases towards the mode's preference.
    const guardGoal = this.mode === 'defensive' ? 1 : 0;
    a.guardRaise += (guardGoal - a.guardRaise) * Math.min(1, dt * 4);
    // Overrides fade out unless an action holds them.
    if (this.time > this.actionUntil) {
      for (const side of ['Left', 'Right'] as const) {
        if (side === 'Left' && this.jab !== 'idle') continue;
        a.handOverride[side].weight = Math.max(0, a.handOverride[side].weight - dt * 5);
      }
    }

    if (this.mode === 'defensive') this.defend();
    if (this.mode === 'sparring') this.spar(dt, playerHead);
  }

  /** React once to each fast incoming punch: block it, slip it, or take it. */
  private defend(): void {
    const head = this.opponent.rig.bones.Head.getWorldPosition(_head);
    for (const hand of this.hands.both) {
      if (!hand.tracked) continue;
      _toHead.subVectors(head, hand.strikePoint);
      const distance = _toHead.length();
      const approach = hand.impactVelocity.dot(_toHead.divideScalar(Math.max(distance, 1e-6)));
      const incoming = distance < 0.6 && approach > 2.5;
      if (!incoming) {
        if (distance > 0.7 || approach < 0.5) this.decided[hand.side] = false;
        continue;
      }
      if (this.decided[hand.side] || this.time < this.actionUntil) continue;
      this.decided[hand.side] = true;
      const roll = Math.random();
      if (roll < 0.45) {
        // Block: the glove on the side the punch comes from moves into its path.
        // Player's right hand arrives on the opponent's left side, and vice versa.
        const side = hand.side === 'right' ? 'Left' : 'Right';
        const override = this.opponent.animator.handOverride[side];
        override.target.copy(head).lerp(hand.strikePoint, 0.45);
        override.weight = 1;
        this.actionUntil = this.time + 0.4;
      } else if (roll < 0.65) {
        // Slip away from the punching hand.
        this.opponent.reactions.dodge(hand.side === 'right' ? -1 : 1, 1);
        this.actionUntil = this.time + 0.5;
      }
    }
  }

  /** Slow, telegraphed jabs with the lead (left) hand. */
  private spar(dt: number, playerHead: Vector3): void {
    const a = this.opponent.animator;
    const override = a.handOverride.Left;
    const handBone = this.opponent.rig.bones.LeftHand;
    this.jabTime += dt;

    switch (this.jab) {
      case 'idle':
        if (this.time >= this.nextJab) {
          this.jab = 'windup';
          this.jabTime = 0;
          this.jabLanded = false;
          handBone.getWorldPosition(this.jabStart);
          // Aim at where the player's head is now (they can see it coming and move).
          this.jabTarget.copy(playerHead);
        }
        break;
      case 'windup': {
        // Telegraph: pull the lead hand back and drop the weight before throwing.
        const t = this.jabTime / WINDUP;
        override.target.copy(this.jabStart).add(_v.set(0, -0.03, -0.07).applyQuaternion(this.opponent.rig.root.quaternion));
        override.weight = Math.min(1, t * 2);
        a.extraOffset.set(0, -0.02 * t, -0.03 * t);
        if (t >= 1) {
          this.jab = 'strike';
          this.jabTime = 0;
        }
        break;
      }
      case 'strike': {
        const t = Math.min(1, this.jabTime / STRIKE);
        const e = t * (2 - t); // ease-out
        // Reach is limited by the arm: aim from the shoulder towards the target.
        this.opponent.rig.bones.LeftArm.getWorldPosition(_shoulder);
        _v.subVectors(this.jabTarget, _shoulder);
        const reach = Math.min(_v.length(), 0.62 * (this.opponent.rig.height / 1.8));
        _v.setLength(reach).add(_shoulder);
        override.target.copy(this.jabStart).lerp(_v, e);
        override.weight = 1;
        a.extraOffset.set(0, -0.02, 0.14 * e);
        this.checkJabContact(playerHead);
        if (t >= 1) {
          this.jab = 'retract';
          this.jabTime = 0;
        }
        break;
      }
      case 'retract': {
        const t = Math.min(1, this.jabTime / RETRACT);
        override.weight = 1 - t;
        a.extraOffset.set(0, -0.02 * (1 - t), 0.14 * (1 - t));
        if (t >= 1) {
          this.jab = 'idle';
          a.extraOffset.set(0, 0, 0);
          this.nextJab = this.time + 2.5 + Math.random() * 2;
        }
        break;
      }
    }
  }

  private checkJabContact(playerHead: Vector3): void {
    if (this.jabLanded) return;
    const hand = this.opponent.rig.bones.LeftHand;
    const tip = this.opponent.rig.bones.LeftHandTip;
    hand.getWorldPosition(_glove);
    if (tip) _glove.lerp(tip.getWorldPosition(_v), 0.6);
    // Blocked by a player's glove/fist in the way?
    for (const h of this.hands.both) {
      if (h.tracked && h.strikePoint.distanceTo(_glove) < BLOCK_RADIUS + h.gear.strikeRadius) {
        this.jabLanded = true;
        this.input.pulse(h.side, 0.5, 40);
        this.audio.playImpact('glove', 0, _glove);
        this.jab = 'retract';
        this.jabTime = 0;
        return;
      }
    }
    if (_glove.distanceTo(playerHead) < JAB_HIT_RADIUS) {
      this.jabLanded = true;
      this.flash.flash(1);
      this.input.pulse('left', 0.8, 120);
      this.input.pulse('right', 0.8, 120);
      this.audio.playImpact('glove', 1, playerHead);
    }
  }
}
