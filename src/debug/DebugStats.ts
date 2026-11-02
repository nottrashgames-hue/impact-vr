/**
 * Shared counters that systems write into and the performance HUD reads.
 * Plain mutable numbers: writing them costs nothing in hot paths.
 */
export const debugStats = {
  /** Draw calls / triangles of the main scene render (captured right after it). */
  drawCalls: 0,
  triangles: 0,
  /** Live blood droplet particles (Section 7.1). */
  particles: 0,
  /** Particle cap of the active quality preset. */
  maxParticles: 0,
  /**
   * Splats / bruise stamps painted into the accumulation render targets since the
   * last clean. These are texture paints, not meshes, so the cost stays constant.
   */
  decals: 0,
  /** Rigid bodies in the physics world. */
  physicsBodies: 0,
  /** Colliders in the physics world (static colliders have no body). */
  physicsColliders: 0,
  /** Wall-clock milliseconds spent in physics steps during the last frame. */
  physicsMs: 0,
  /** Fixed physics steps taken during the last frame. */
  physicsSteps: 0,
  /** Opponent summary, e.g. "procedural · 52.1k tris · 21 hitboxes". */
  opponent: '',
  /** Result of the debug hit probe (zone / collider / UV under the pointer). */
  probe: '',
  /** Last registered impact: tier, punch type, zone, speed, damage, UV (Section 12). */
  lastHit: '',
  /** Knockout meter and punch totals. */
  knockout: '',
};
