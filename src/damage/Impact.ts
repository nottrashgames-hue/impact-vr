import { Quaternion, Vector3, type Vector2 } from 'three';
import { PUNCH } from '../config';
import type { Handedness } from '../input/XRInput';
import type { CanonicalBone } from '../opponent/HumanoidRig';
import type { GearProfile } from '../player/GearProfile';
import type { ZoneId } from './Zones';

export type ImpactTier = 'light' | 'medium' | 'heavy' | 'devastating';
export type PunchType = 'jab' | 'cross' | 'hook' | 'uppercut' | 'slap';
/** What the player hit with (gloves arrive in Milestone 4). */
export type StrikeSurface = 'fist' | 'openHand';

export const IMPACT_TIERS: readonly ImpactTier[] = ['light', 'medium', 'heavy', 'devastating'];

/** A registered hit on the opponent: everything downstream systems need. */
export interface Impact {
  readonly side: Handedness;
  readonly surface: StrikeSurface;
  /** Bare fist or glove profile (damage, cut, bleed, bruise multipliers; brush size). */
  readonly gear: GearProfile;
  /** Hand velocity component into the surface (m/s). */
  readonly speed: number;
  /** Full hand speed (m/s), for stats. */
  readonly handSpeed: number;
  readonly tier: ImpactTier;
  readonly punchType: PunchType;
  readonly zone: ZoneId;
  readonly hitbox: string;
  readonly bone: CanonicalBone;
  /** Contact point on the opponent (world). */
  readonly point: Vector3;
  /** Outward surface normal at the contact (world). */
  readonly normal: Vector3;
  /** Unit direction of the hand's motion. */
  readonly direction: Vector3;
  /** Head-mesh UV for face hits. */
  readonly uv: Vector2 | null;
  readonly time: number;
}

/** Light / medium / heavy / devastating (Section 4), or null below the touch threshold. */
export function classifyTier(speed: number): ImpactTier | null {
  if (speed < PUNCH.minSpeed) return null;
  if (speed < PUNCH.lightMax) return 'light';
  if (speed < PUNCH.mediumMax) return 'medium';
  if (speed < PUNCH.heavyMax) return 'heavy';
  return 'devastating';
}

export function tierIndex(tier: ImpactTier): number {
  return IMPACT_TIERS.indexOf(tier);
}

const _local = new Vector3();
const _unyaw = new Quaternion();
const UP = new Vector3(0, 1, 0);

/**
 * Names the punch from the hand's direction of travel relative to the player's
 * head (yaw only): mostly upward = uppercut, mostly sideways towards the
 * centre line = hook, otherwise a straight (jab with the lead hand, cross
 * with the rear hand).
 */
export function classifyPunchType(side: Handedness, direction: Vector3, headQuaternion: Quaternion, surface: StrikeSurface): PunchType {
  if (surface === 'openHand') return 'slap';
  // Remove the head's yaw so "forward" is where the player is facing.
  const yaw = Math.atan2(
    2 * (headQuaternion.w * headQuaternion.y + headQuaternion.x * headQuaternion.z),
    1 - 2 * (headQuaternion.y * headQuaternion.y + headQuaternion.x * headQuaternion.x),
  );
  _local.copy(direction).applyQuaternion(_unyaw.setFromAxisAngle(UP, -yaw)).normalize();

  const forward = -_local.z;
  const up = _local.y;
  // Inward = towards the body's centre line: -x for the right hand, +x for the left.
  const inward = side === 'right' ? -_local.x : _local.x;
  if (up > 0.55 && up > forward * 0.8) return 'uppercut';
  if (inward > 0.6 && inward > forward) return 'hook';
  return side === PUNCH.leadHand ? 'jab' : 'cross';
}
