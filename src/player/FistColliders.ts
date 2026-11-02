import RAPIER from '@dimforge/rapier3d-compat';
import { COLLISION_GROUP, interactionGroups, type Physics } from '../core/Physics';
import type { PlayerHands } from './PlayerHands';

/** Where untracked or suspended fists are parked so they touch nothing. */
const PARKED = { x: 0, y: -50, z: 0 };

/**
 * Kinematic strike spheres that follow the player's fists or gloves
 * (Section 4). Hit *detection* is done by sweeping the same sphere
 * (PunchDetector); these bodies give the fists physical presence, e.g.
 * shoving a ragdolled opponent.
 */
export class FistColliders {
  private readonly bodies: RAPIER.RigidBody[];
  private readonly colliders: RAPIER.Collider[] = [];
  private suspendedUntil = -1;

  constructor(
    physics: Physics,
    private readonly hands: PlayerHands,
  ) {
    const groups = interactionGroups(COLLISION_GROUP.PLAYER, COLLISION_GROUP.OPPONENT);
    this.bodies = hands.both.map((hand) => {
      const body = physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(PARKED.x, PARKED.y, PARKED.z),
      );
      this.colliders.push(
        physics.world.createCollider(
          RAPIER.ColliderDesc.ball(hand.gear.strikeRadius).setCollisionGroups(groups).setDensity(1000),
          body,
        ),
      );
      return body;
    });
  }

  /**
   * Parks the fists for a moment, e.g. when the opponent goes limp: a fist
   * still buried in the face would otherwise shove the ragdoll violently.
   */
  suspend(now: number, seconds: number): void {
    this.suspendedUntil = now + seconds;
    for (const body of this.bodies) body.setTranslation(PARKED, false);
  }

  /** Pushes this frame's strike points as kinematic targets (applied on the next physics step). */
  update(now: number): void {
    const suspended = now < this.suspendedUntil;
    this.hands.both.forEach((hand, i) => {
      const collider = this.colliders[i];
      if (collider.radius() !== hand.gear.strikeRadius) collider.setRadius(hand.gear.strikeRadius);
      this.bodies[i].setNextKinematicTranslation(hand.tracked && !suspended ? hand.strikePoint : PARKED);
    });
  }
}
