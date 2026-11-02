import RAPIER from '@dimforge/rapier3d-compat';
import { type Quaternion, Vector3 } from 'three';
import { PUNCH } from '../config';

import { COLLISION_GROUP, interactionGroups, type Physics } from '../core/Physics';
import { classifyPunchType, classifyTier, type Impact } from '../damage/Impact';
import type { Handedness } from '../input/XRInput';
import type { Opponent } from '../opponent/Opponent';
import type { PlayerHands } from './PlayerHands';

interface FistState {
  readonly previous: Vector3;
  hasPrevious: boolean;
  /** Touching the opponent since the last registered hit (no re-trigger until it leaves). */
  inContact: boolean;
  cooldownUntil: number;
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const _displacement = new Vector3();
const _normal = new Vector3();
const _point = new Vector3();
const _direction = new Vector3();

/**
 * Detects punches (Section 4). Every frame each fist's strike sphere is swept
 * from its previous position to its current one against the opponent's
 * hitboxes, so even a 10 m/s punch (≈11 cm per frame) cannot tunnel through a
 * forearm. A hit registers on first contact, using the hand-velocity component
 * along the surface normal, with a per-fist cooldown.
 */
export class PunchDetector {
  /** Sweep shapes by radius (bare fist and each glove weight). */
  private readonly shapes = new Map<number, RAPIER.Ball>();
  private readonly groups = interactionGroups(COLLISION_GROUP.PLAYER, COLLISION_GROUP.OPPONENT);
  private readonly fists: Record<Handedness, FistState> = {
    left: { previous: new Vector3(), hasPrevious: false, inContact: false, cooldownUntil: 0 },
    right: { previous: new Vector3(), hasPrevious: false, inContact: false, cooldownUntil: 0 },
  };

  constructor(
    private readonly physics: Physics,
    private readonly opponent: Opponent,
    private readonly hands: PlayerHands,
  ) {}

  private shapeFor(radius: number): RAPIER.Ball {
    let shape = this.shapes.get(radius);
    if (!shape) {
      shape = new RAPIER.Ball(radius);
      this.shapes.set(radius, shape);
    }
    return shape;
  }

  /** Forget previous positions (after a recenter or mode switch). */
  reset(): void {
    for (const state of Object.values(this.fists)) {
      state.hasPrevious = false;
      state.inContact = false;
    }
  }

  /**
   * @param time           seconds (same clock as the hand samples)
   * @param headQuaternion the player's head orientation, for naming punches
   */
  update(time: number, headQuaternion: Quaternion, onImpact: (impact: Impact) => void): void {
    for (const hand of this.hands.both) {
      const state = this.fists[hand.side];
      if (!hand.tracked) {
        state.hasPrevious = false;
        state.inContact = false;
        continue;
      }
      const current = hand.strikePoint;
      if (!state.hasPrevious) {
        state.previous.copy(current);
        state.hasPrevious = true;
        continue;
      }

      _displacement.subVectors(current, state.previous);
      const hit = this.physics.world.castShape(
        state.previous,
        IDENTITY,
        _displacement,
        this.shapeFor(hand.gear.strikeRadius),
        0,
        1,
        true,
        undefined,
        this.groups,
      );
      state.previous.copy(current);
      if (!hit) {
        state.inContact = false;
        continue;
      }
      if (state.inContact) continue;
      state.inContact = true;
      if (time < state.cooldownUntil) continue;

      // Speed into the surface: hand velocity against the outward normal of the hit collider.
      _normal.set(hit.normal1.x, hit.normal1.y, hit.normal1.z);
      const velocity = hand.impactVelocity;
      // Heavier gloves swing a touch slower.
      const speed = -velocity.dot(_normal) * hand.gear.speedFactor;
      const tier = classifyTier(speed);
      if (!tier) continue;

      const handSpeed = velocity.length();
      _direction.copy(velocity).divideScalar(Math.max(handSpeed, 1e-6));
      _point.set(hit.witness1.x, hit.witness1.y, hit.witness1.z);
      const contact = this.opponent.describeContact(hit.collider, _point, _normal, _direction);
      if (!contact) continue;

      state.cooldownUntil = time + PUNCH.cooldown;
      onImpact({
        side: hand.side,
        surface: hand.surface,
        gear: hand.gear,
        speed,
        handSpeed,
        tier,
        punchType: classifyPunchType(hand.side, _direction, headQuaternion, hand.surface),
        zone: contact.zone,
        hitbox: contact.hitbox,
        bone: contact.bone,
        point: contact.point,
        normal: contact.normal,
        direction: _direction.clone(),
        uv: contact.uv,
        time,
      });
    }
  }
}
