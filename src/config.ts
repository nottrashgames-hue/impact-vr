/**
 * Global layout and tuning constants.
 *
 * Coordinate conventions (metres, right-handed, Y up):
 *  - The top of the ring canvas is y = 0, which is the player's real floor in VR.
 *  - The ring is centred on the world origin.
 *  - The player faces -Z towards the opponent; the opponent faces +Z.
 */

const params = new URLSearchParams(window.location.search);

/** World placement of the player and the opponent. */
export const WORLD = {
  /** Head position (x/z only) the player is placed at on spawn / recenter. */
  playerSpawnX: 0,
  playerSpawnZ: 0.5,
  /** Yaw (radians) the player faces after recentering. 0 = facing -Z. */
  playerSpawnYaw: 0,
  /** Opponent root (feet) position — 1 m in front of the player. */
  opponentX: 0,
  opponentZ: -0.5,
  /** Eye height used in desktop mode and when only a 'local' XR space is available. */
  desktopEyeHeight: 1.7,
  /** Desktop walking is clamped to this half-extent so you stay inside the ropes. */
  desktopMoveLimit: 2.7,
} as const;

/** Boxing ring dimensions. */
export const RING = {
  /** Side length of the canvas floor plane (includes the apron outside the ropes). */
  floorSize: 7.2,
  /** Half-extent of the square formed by the ropes/corner posts. */
  ropeHalfExtent: 3.0,
  /** Height of the rope tiers above the canvas. */
  ropeHeights: [0.46, 0.79, 1.12, 1.45],
  /** The gym floor is this far below the canvas (ring platform height). */
  platformHeight: 1.0,
  /** Corner post height above the canvas. */
  postHeight: 1.62,
} as const;

/** Gym room dimensions (centred on the ring). */
export const ROOM = {
  width: 20, // along X
  depth: 20, // along Z
  /** Ceiling height measured from the gym floor. */
  height: 6,
} as const;

/** Physics fixed timestep and substep cap. */
export const PHYSICS = {
  fixedStep: 1 / 90,
  maxSubSteps: 4,
  gravity: -9.81,
} as const;

/** Punch detection (Section 4). Speeds are the hand-velocity component into the surface, in m/s. */
export const PUNCH = {
  /** Below this it is a touch, not a hit. */
  minSpeed: 1.0,
  /** Tier upper bounds: light < 3 <= medium < 5.5 <= heavy < 8 <= devastating. */
  lightMax: 3.0,
  mediumMax: 5.5,
  heavyMax: 8.0,
  /** Per-fist cooldown so one punch registers once (seconds). */
  cooldown: 0.12,
  /** Lead hand for jab/cross naming (orthodox stance leads with the left). */
  leadHand: 'left' as 'left' | 'right',
  /** Radius of the bare-fist strike sphere (metres). */
  fistRadius: 0.036,
  /** Damage multiplier for an open hand (hand tracking, fingers not curled). */
  openHandMultiplier: 0.25,
} as const;

/** Knockout rules (Section 3). */
export const KNOCKOUT = {
  /** A single hit whose knockout contribution reaches this drops the opponent. */
  singleHitThreshold: 70,
  /** Knockout meter (0..100) recovery per second, after `meterRecoveryDelay` without head damage. */
  meterRecoveryPerSecond: 4,
  meterRecoveryDelay: 1.5,
  /** 'prompt' waits for a reset; 'getUp' stands back up automatically (override with ?ko=getup). */
  recovery: (params.get('ko') === 'getup' ? 'getUp' : 'prompt') as 'prompt' | 'getUp',
  /** Seconds on the floor before the prompt appears / before getting up. */
  promptDelay: 1.5,
  getUpDelay: 5,
  getUpDuration: 1.6,
} as const;

/** Values that can be overridden from the URL, e.g. `?debug=1&quality=quest2`. */
export const URL_FLAGS = {
  /** Show the debug/performance HUD at startup (defaults to on in dev builds). */
  debug: params.has('debug') ? params.get('debug') !== '0' : import.meta.env.DEV,
  /** Force a quality preset: quest2 | quest3 | pc. */
  quality: params.get('quality'),
} as const;
