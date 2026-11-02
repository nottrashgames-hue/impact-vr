/**
 * What the player hits with (Section 4): bare fists concentrate force (more
 * cuts, split lips, nosebleeds); gloves spread it (less cutting, slightly less
 * bleeding, more bruising and swelling). Glove weight trades a little damage
 * and swing speed for padding.
 */

export type GloveWeight = 10 | 12 | 16;
export type GloveColor = 'red' | 'black' | 'blue' | 'white';

export const GLOVE_COLORS: Readonly<Record<GloveColor, number>> = {
  red: 0xb3171b,
  black: 0x18191c,
  blue: 0x1d3f8f,
  white: 0xe8e8e8,
};
export const GLOVE_COLOR_NAMES = Object.keys(GLOVE_COLORS) as GloveColor[];
export const GLOVE_WEIGHTS: readonly GloveWeight[] = [10, 12, 16];

export interface GearProfile {
  readonly kind: 'bare' | 'glove';
  readonly label: string;
  /** Multiplier on impact damage. */
  readonly damageMult: number;
  /** Multiplier on the chance of opening a cut. */
  readonly cutMult: number;
  /** Multiplier on bleeding (nosebleed chance and severity, splatter). */
  readonly bleedMult: number;
  readonly bruiseMult: number;
  readonly swellMult: number;
  /** Bruise brush radius (m) and hardness (0 soft .. 1 hard edge). */
  readonly brushRadius: number;
  readonly brushHardness: number;
  /** Strike sphere radius (m). */
  readonly strikeRadius: number;
  /** Effective speed factor: heavier gloves swing a touch slower. */
  readonly speedFactor: number;
  /** Haptic strength multiplier. */
  readonly hapticMult: number;
}

export const BARE_FIST: GearProfile = {
  kind: 'bare',
  label: 'Bare fists',
  damageMult: 1,
  cutMult: 1,
  bleedMult: 1,
  bruiseMult: 1,
  swellMult: 1,
  brushRadius: 0.022,
  brushHardness: 0.4,
  strikeRadius: 0.036,
  speedFactor: 1,
  hapticMult: 1,
};

export function gloveProfile(weight: GloveWeight): GearProfile {
  const t = (weight - 10) / 6; // 0 for 10 oz .. 1 for 16 oz
  return {
    kind: 'glove',
    label: `${weight} oz gloves`,
    damageMult: 0.9 - 0.2 * t,
    cutMult: 0.12,
    bleedMult: 0.65,
    bruiseMult: 1.35,
    swellMult: 1.45,
    brushRadius: 0.04 + 0.008 * t,
    brushHardness: 0.12,
    strikeRadius: 0.054 + 0.01 * t,
    speedFactor: 1 - 0.05 * t,
    hapticMult: 1.15 + 0.25 * t,
  };
}
