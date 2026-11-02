import { Vector3 } from 'three';
import { sq } from '../../core/mathUtils';
import type { CanonicalBone } from '../HumanoidRig';
import type { AtlasRect, LoftRing } from './geometryBuilders';
import { eyeCenter } from './HeadModel';

/**
 * Proportions of the procedural opponent: a 1.80 m adult male, rest pose with
 * the arms hanging slightly out (A-pose). Character space: feet at y = 0,
 * facing +Z, +X = the character's left.
 */

export const OPPONENT_HEIGHT = 1.8;

/** Skull centre at eye level (origin of HeadModel's head space). */
export const HEAD_CENTER = new Vector3(0, 1.67, 0.012);

interface BoneRest {
  readonly parent: CanonicalBone | null;
  readonly position: Vector3;
}

const v = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z);
const leftEye = eyeCenter(1, new Vector3()).add(HEAD_CENTER);
const rightEye = eyeCenter(-1, new Vector3()).add(HEAD_CENTER);

/** Rest (bind) pose joint positions in character space. All rest rotations are identity. */
export const BONE_REST: Readonly<Record<CanonicalBone, BoneRest>> = {
  Hips: { parent: null, position: v(0, 0.97, 0) },
  Spine: { parent: 'Hips', position: v(0, 1.06, -0.005) },
  Spine1: { parent: 'Spine', position: v(0, 1.17, -0.005) },
  Spine2: { parent: 'Spine1', position: v(0, 1.29, -0.01) },
  Neck: { parent: 'Spine2', position: v(0, 1.47, -0.015) },
  Head: { parent: 'Neck', position: v(0, 1.585, -0.008) },
  Jaw: { parent: 'Head', position: v(0, 1.645, 0) },
  LeftEye: { parent: 'Head', position: leftEye },
  RightEye: { parent: 'Head', position: rightEye },
  LeftUpperLid: { parent: 'Head', position: leftEye.clone() },
  RightUpperLid: { parent: 'Head', position: rightEye.clone() },
  LeftShoulder: { parent: 'Spine2', position: v(0.025, 1.43, -0.02) },
  LeftArm: { parent: 'LeftShoulder', position: v(0.185, 1.43, -0.025) },
  LeftForeArm: { parent: 'LeftArm', position: v(0.245, 1.146, -0.025) },
  LeftHand: { parent: 'LeftForeArm', position: v(0.299, 0.892, -0.025) },
  LeftHandTip: { parent: 'LeftHand', position: v(0.318, 0.8, -0.025) },
  RightShoulder: { parent: 'Spine2', position: v(-0.025, 1.43, -0.02) },
  RightArm: { parent: 'RightShoulder', position: v(-0.185, 1.43, -0.025) },
  RightForeArm: { parent: 'RightArm', position: v(-0.245, 1.146, -0.025) },
  RightHand: { parent: 'RightForeArm', position: v(-0.299, 0.892, -0.025) },
  RightHandTip: { parent: 'RightHand', position: v(-0.318, 0.8, -0.025) },
  LeftUpLeg: { parent: 'Hips', position: v(0.095, 0.93, 0) },
  LeftLeg: { parent: 'LeftUpLeg', position: v(0.1, 0.51, 0.005) },
  LeftFoot: { parent: 'LeftLeg', position: v(0.105, 0.085, -0.01) },
  LeftToeBase: { parent: 'LeftFoot', position: v(0.105, 0.02, 0.13) },
  RightUpLeg: { parent: 'Hips', position: v(-0.095, 0.93, 0) },
  RightLeg: { parent: 'RightUpLeg', position: v(-0.1, 0.51, 0.005) },
  RightFoot: { parent: 'RightLeg', position: v(-0.105, 0.085, -0.01) },
  RightToeBase: { parent: 'RightFoot', position: v(-0.105, 0.02, 0.13) },
};

/** Upper-lid rotation (about X) of the open pose baked into the lid geometry, and the closed delta. */
export const LID_OPEN_ANGLE = (-32 * Math.PI) / 180;
export const LID_CLOSE_DELTA = (55 * Math.PI) / 180;

// ---------------------------------------------------------------------------
// UV atlas: every skin/cloth part gets its own non-overlapping rectangle so a
// single paint render target can hold bruises and blood for the whole body.
// ---------------------------------------------------------------------------

export const ATLAS = {
  head: { u0: 0, v0: 0.5, w: 0.5, h: 0.5 },
  torso: { u0: 0.5, v0: 0.5, w: 0.5, h: 0.5 },
  neck: { u0: 0.5, v0: 0.375, w: 0.25, h: 0.125 },
  earLeft: { u0: 0.75, v0: 0.375, w: 0.0625, h: 0.125 },
  earRight: { u0: 0.8125, v0: 0.375, w: 0.0625, h: 0.125 },
  armLeft: { u0: 0, v0: 0, w: 0.125, h: 0.5 },
  armRight: { u0: 0.125, v0: 0, w: 0.125, h: 0.5 },
  legLeft: { u0: 0.25, v0: 0, w: 0.125, h: 0.5 },
  legRight: { u0: 0.375, v0: 0, w: 0.125, h: 0.5 },
  shortsPelvis: { u0: 0.5, v0: 0.1875, w: 0.5, h: 0.1875 },
  shortsLegLeft: { u0: 0.5, v0: 0, w: 0.25, h: 0.1875 },
  shortsLegRight: { u0: 0.75, v0: 0, w: 0.25, h: 0.1875 },
} as const satisfies Record<string, AtlasRect>;

// ---------------------------------------------------------------------------
// Loft profiles
// ---------------------------------------------------------------------------

/** Torso from the crotch to the base of the neck (character space). */
export const TORSO_RINGS: readonly LoftRing[] = [
  { y: 0.84, rx: 0.135, rz: 0.095, dz: -0.005 },
  { y: 0.9, rx: 0.165, rz: 0.11, dz: -0.012 },
  { y: 0.97, rx: 0.165, rz: 0.108, dz: -0.01 },
  { y: 1.04, rx: 0.15, rz: 0.098, dz: 0 },
  { y: 1.1, rx: 0.145, rz: 0.095, dz: 0.005 },
  { y: 1.17, rx: 0.15, rz: 0.1, dz: 0.008 },
  { y: 1.24, rx: 0.16, rz: 0.108, dz: 0.01 },
  { y: 1.31, rx: 0.17, rz: 0.115, dz: 0.008 },
  { y: 1.37, rx: 0.178, rz: 0.112, dz: 0 },
  { y: 1.42, rx: 0.18, rz: 0.1, dz: -0.012 },
  { y: 1.46, rx: 0.15, rz: 0.08, dz: -0.018 },
  { y: 1.49, rx: 0.095, rz: 0.065, dz: -0.02 },
  { y: 1.51, rx: 0.06, rz: 0.055, dz: -0.02 },
];

/** Muscle definition on the torso (outward displacement in metres). */
export function torsoDisplacement(angle: number, y: number, x: number): number {
  const front = Math.max(0, Math.cos(angle));
  const back = Math.max(0, -Math.cos(angle));
  const ax = Math.abs(x);
  let d = 0;
  d += 0.012 * front * Math.exp(-sq((ax - 0.075) / 0.05) - sq((y - 1.33) / 0.035)); // pectorals
  d -= 0.003 * front * Math.exp(-sq(x / 0.006)) * (y > 1.05 && y < 1.27 ? 1 : 0); // linea alba
  d += 0.008 * back * Math.exp(-sq((ax - 0.08) / 0.045) - sq((y - 1.33) / 0.05)); // shoulder blades
  d -= 0.006 * back * Math.exp(-sq(x / 0.012)) * (y > 1.0 && y < 1.45 ? 1 : 0); // spine groove
  d += 0.02 * back * Math.exp(-sq((ax - 0.075) / 0.06) - sq((y - 0.92) / 0.05)); // glutes
  return d;
}

export const NECK_RINGS: readonly LoftRing[] = [
  { y: 1.44, rx: 0.058, rz: 0.062, dz: -0.015 },
  { y: 1.5, rx: 0.056, rz: 0.06, dz: -0.015 },
  { y: 1.56, rx: 0.054, rz: 0.058, dz: -0.014 },
  { y: 1.6, rx: 0.052, rz: 0.056, dz: -0.014 },
  { y: 1.63, rx: 0.05, rz: 0.052, dz: -0.016 },
];

/** Adam's apple. */
export function neckDisplacement(angle: number, y: number): number {
  return 0.005 * Math.max(0, Math.cos(angle)) ** 8 * Math.exp(-sq((y - 1.535) / 0.012));
}

/**
 * Arm profile: `y` = -distance from the shoulder joint along the arm (so the
 * list is ascending from the wrist up to above the shoulder).
 */
export const ARM_RINGS: readonly LoftRing[] = [
  { y: -0.55, rx: 0.026, rz: 0.023 },
  { y: -0.48, rx: 0.031, rz: 0.028 },
  { y: -0.4, rx: 0.038, rz: 0.037 },
  { y: -0.33, rx: 0.04, rz: 0.041 },
  { y: -0.29, rx: 0.036, rz: 0.038 },
  { y: -0.22, rx: 0.04, rz: 0.041 },
  { y: -0.16, rx: 0.044, rz: 0.046 },
  { y: -0.1, rx: 0.046, rz: 0.047 },
  { y: -0.05, rx: 0.052, rz: 0.05 },
  { y: 0, rx: 0.055, rz: 0.055 },
  { y: 0.025, rx: 0.042, rz: 0.044 },
];

/** Leg profile: `y` = -distance from the hip joint (ascending from the ankle). */
export const LEG_RINGS: readonly LoftRing[] = [
  { y: -0.84, rx: 0.031, rz: 0.032 },
  { y: -0.76, rx: 0.035, rz: 0.036 },
  { y: -0.64, rx: 0.046, rz: 0.05, dz: -0.008 },
  { y: -0.53, rx: 0.052, rz: 0.058, dz: -0.01 },
  { y: -0.45, rx: 0.05, rz: 0.05 },
  { y: -0.4, rx: 0.051, rz: 0.052 },
  { y: -0.3, rx: 0.06, rz: 0.062 },
  { y: -0.18, rx: 0.072, rz: 0.075 },
  { y: -0.08, rx: 0.082, rz: 0.085 },
  { y: 0, rx: 0.085, rz: 0.088 },
  { y: 0.05, rx: 0.07, rz: 0.07 },
];

/** Shorts around the pelvis (character space), with the waistband folding inwards at the top. */
export const SHORTS_PELVIS_RINGS: readonly LoftRing[] = [
  { y: 0.8, rx: 0.135, rz: 0.098, dz: -0.006 },
  { y: 0.86, rx: 0.176, rz: 0.12, dz: -0.012 },
  { y: 0.93, rx: 0.181, rz: 0.122, dz: -0.012 },
  { y: 1.0, rx: 0.171, rz: 0.114, dz: -0.006 },
  { y: 1.06, rx: 0.161, rz: 0.107, dz: 0.001 },
  { y: 1.09, rx: 0.159, rz: 0.106, dz: 0.004 },
  { y: 1.093, rx: 0.146, rz: 0.096, dz: 0.005 },
];

/** Shorts leg sleeves: `y` = -distance from the hip joint, hem folding inwards at the bottom. */
export const SHORTS_LEG_RINGS: readonly LoftRing[] = [
  { y: -0.225, rx: 0.07, rz: 0.073 },
  { y: -0.22, rx: 0.084, rz: 0.087 },
  { y: -0.12, rx: 0.093, rz: 0.096 },
  { y: -0.02, rx: 0.099, rz: 0.102 },
  { y: 0.04, rx: 0.095, rz: 0.098 },
];

/** Heights of the torso rings, for converting torso UV v back to a height. */
export function torsoHeightAtV(vCoord: number): number {
  const f = vCoord * (TORSO_RINGS.length - 1);
  const i = Math.min(TORSO_RINGS.length - 2, Math.max(0, Math.floor(f)));
  return TORSO_RINGS[i].y + (TORSO_RINGS[i + 1].y - TORSO_RINGS[i].y) * (f - i);
}

/** Half width of the torso at a height (linear between rings). */
export function torsoHalfWidthAt(y: number): number {
  const r = TORSO_RINGS;
  if (y <= r[0].y) return r[0].rx;
  for (let i = 0; i < r.length - 1; i++) {
    if (y <= r[i + 1].y) return r[i].rx + ((r[i + 1].rx - r[i].rx) * (y - r[i].y)) / (r[i + 1].y - r[i].y);
  }
  return r[r.length - 1].rx;
}
