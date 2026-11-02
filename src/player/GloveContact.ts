import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import { COLLISION_GROUP, interactionGroups, type Physics } from '../core/Physics';
import type { XRInput } from '../input/XRInput';
import type { Opponent } from '../opponent/Opponent';
import type { PlayerHands } from './PlayerHands';

/** Push acceleration (m/s²) per metre the glove sinks into the body. */
const CONTACT_STIFFNESS = 320;
/** Extra push from the glove's speed into the surface (1/s). */
const CONTACT_DAMPING = 6;
const MAX_FORCE = 25;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const QUERY_GROUPS = interactionGroups(COLLISION_GROUP.PLAYER, COLLISION_GROUP.OPPONENT);

const _normal = new Vector3();
const _force = new Vector3();
const _point = new Vector3();

/**
 * Gloves (or fists) touching the standing opponent push him around even
 * without a punch (Section 4): each frame, the strike sphere's overlap with
 * his hitboxes becomes a spring-like push on his body. A light buzz in the
 * controller tells the player they are leaning on him.
 */
export class GloveContact {
  private readonly balls = new Map<number, RAPIER.Ball>();
  private hapticCooldown = { left: 0, right: 0 };

  constructor(
    private readonly physics: Physics,
    private readonly hands: PlayerHands,
    private readonly opponent: Opponent,
    private readonly input: XRInput,
  ) {}

  update(dt: number): void {
    if (this.opponent.state !== 'standing') return;
    for (const hand of this.hands.both) {
      this.hapticCooldown[hand.side] -= dt;
      if (!hand.tracked) continue;
      const radius = hand.gear.strikeRadius;
      const ball = this.ballOf(radius);
      let pressing = 0;
      this.physics.world.intersectionsWithShape(
        hand.strikePoint,
        IDENTITY,
        ball,
        (collider) => {
          const contact = collider.contactShape(ball, hand.strikePoint, IDENTITY, 0);
          if (!contact || contact.distance >= 0) return true;
          const depth = -contact.distance;
          // normal1 points out of his body, towards the glove: push the other way.
          _normal.set(contact.normal1.x, contact.normal1.y, contact.normal1.z);
          const into = Math.max(0, -hand.impactVelocity.dot(_normal));
          const magnitude = Math.min(MAX_FORCE, CONTACT_STIFFNESS * depth + CONTACT_DAMPING * into);
          _force.copy(_normal).multiplyScalar(-magnitude);
          _point.set(contact.point1.x, contact.point1.y, contact.point1.z);
          this.opponent.push(collider, _point, _force, dt);
          pressing = Math.max(pressing, magnitude);
          return true;
        },
        undefined,
        QUERY_GROUPS,
      );
      if (pressing > 2 && this.hapticCooldown[hand.side] <= 0) {
        this.input.pulse(hand.side, Math.min(0.35, 0.06 + pressing / 80), 25);
        this.hapticCooldown[hand.side] = 0.08;
      }
    }
  }

  private ballOf(radius: number): RAPIER.Ball {
    let ball = this.balls.get(radius);
    if (!ball) {
      ball = new RAPIER.Ball(radius);
      this.balls.set(radius, ball);
    }
    return ball;
  }
}
