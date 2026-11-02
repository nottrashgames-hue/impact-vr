import RAPIER from '@dimforge/rapier3d-compat';
import { PHYSICS } from '../config';
import { debugStats } from '../debug/DebugStats';

/** Collision group bits (Rapier interaction groups: 16-bit membership + 16-bit filter). */
export const COLLISION_GROUP = {
  STATIC: 1 << 0,
  OPPONENT: 1 << 1,
  PLAYER: 1 << 2,
} as const;

export function interactionGroups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

/**
 * Thin owner of the Rapier world. Stepped from the fixed-timestep loop; later
 * milestones add the opponent's per-bone bodies, ragdoll joints and the
 * kinematic fist colliders to this world.
 */
export class Physics {
  readonly world: RAPIER.World;
  private stepMsAccum = 0;
  private stepsAccum = 0;

  private constructor() {
    this.world = new RAPIER.World({ x: 0, y: PHYSICS.gravity, z: 0 });
    this.world.timestep = PHYSICS.fixedStep;
  }

  /** Loads the (inlined) Rapier WASM module and creates the world. */
  static async create(): Promise<Physics> {
    await RAPIER.init();
    return new Physics();
  }

  /** Adds a static axis-aligned box collider (centre + half extents). */
  addStaticBox(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(cx, cy, cz)
      .setCollisionGroups(interactionGroups(COLLISION_GROUP.STATIC, 0xffff));
    return this.world.createCollider(desc);
  }

  step(dt: number): void {
    const t0 = performance.now();
    this.world.timestep = dt;
    this.world.step();
    this.stepMsAccum += performance.now() - t0;
    this.stepsAccum++;
  }

  /** Publishes per-frame physics timing to the debug HUD and resets the counters. */
  endFrame(): void {
    debugStats.physicsMs = this.stepMsAccum;
    debugStats.physicsSteps = this.stepsAccum;
    debugStats.physicsBodies = this.world.bodies.len();
    debugStats.physicsColliders = this.world.colliders.len();
    this.stepMsAccum = 0;
    this.stepsAccum = 0;
  }
}
