/**
 * Damage zones (Section 5). Hitboxes and face regions resolve to one of these
 * IDs; the damage, bleeding and bruising systems read their multipliers.
 */

export type FaceZoneId = 'nose' | 'eyeLeft' | 'eyeRight' | 'brow' | 'cheekLeft' | 'cheekRight' | 'mouth' | 'jaw';
export type ZoneId = FaceZoneId | 'head' | 'torso' | 'stomach' | 'arms' | 'legs';

export interface ZoneDef {
  readonly id: ZoneId;
  readonly label: string;
  /** Multiplier applied to impact damage. */
  readonly damageMult: number;
  /** 0..1 scale on the chance that a qualifying hit makes this zone bleed. */
  readonly bleedChance: number;
  /** 0..1 speed at which bruising builds up. */
  readonly bruiseRate: number;
  /** Weight of damage here towards a knockout (jaw is highest). */
  readonly knockoutFactor: number;
  /** Debug visualisation colour. */
  readonly color: number;
}

// Qualitative levels from the design table.
const VERY_HIGH = 0.9;
const HIGH = 0.6;
const LOW = 0.15;
const NONE = 0;
const BRUISE_VERY_HIGH = 1;
const BRUISE_HIGH = 0.75;
const BRUISE_MEDIUM = 0.5;
const BRUISE_LOW = 0.25;

export const ZONES: Readonly<Record<ZoneId, ZoneDef>> = {
  nose: { id: 'nose', label: 'Nose', damageMult: 1.5, bleedChance: VERY_HIGH, bruiseRate: BRUISE_MEDIUM, knockoutFactor: 1.0, color: 0xff3b30 },
  eyeLeft: { id: 'eyeLeft', label: 'Left eye', damageMult: 1.3, bleedChance: LOW, bruiseRate: BRUISE_VERY_HIGH, knockoutFactor: 0.8, color: 0x7c4dff },
  eyeRight: { id: 'eyeRight', label: 'Right eye', damageMult: 1.3, bleedChance: LOW, bruiseRate: BRUISE_VERY_HIGH, knockoutFactor: 0.8, color: 0xb388ff },
  brow: { id: 'brow', label: 'Brow / forehead', damageMult: 1.2, bleedChance: HIGH, bruiseRate: BRUISE_MEDIUM, knockoutFactor: 0.9, color: 0xffcc00 },
  cheekLeft: { id: 'cheekLeft', label: 'Left cheek', damageMult: 1.1, bleedChance: LOW, bruiseRate: BRUISE_HIGH, knockoutFactor: 1.0, color: 0x34c759 },
  cheekRight: { id: 'cheekRight', label: 'Right cheek', damageMult: 1.1, bleedChance: LOW, bruiseRate: BRUISE_HIGH, knockoutFactor: 1.0, color: 0x30d0a0 },
  mouth: { id: 'mouth', label: 'Mouth / lips', damageMult: 1.2, bleedChance: HIGH, bruiseRate: BRUISE_MEDIUM, knockoutFactor: 1.0, color: 0xff2d92 },
  jaw: { id: 'jaw', label: 'Jaw / chin', damageMult: 1.4, bleedChance: LOW, bruiseRate: BRUISE_MEDIUM, knockoutFactor: 1.6, color: 0xff9500 },
  head: { id: 'head', label: 'Head (back/top)', damageMult: 1.0, bleedChance: LOW, bruiseRate: BRUISE_LOW, knockoutFactor: 1.1, color: 0x5ac8fa },
  torso: { id: 'torso', label: 'Torso / ribs', damageMult: 0.7, bleedChance: NONE, bruiseRate: BRUISE_MEDIUM, knockoutFactor: 0.25, color: 0x007aff },
  stomach: { id: 'stomach', label: 'Stomach', damageMult: 0.6, bleedChance: NONE, bruiseRate: BRUISE_LOW, knockoutFactor: 0.3, color: 0x5856d6 },
  arms: { id: 'arms', label: 'Arms (guard)', damageMult: 0.2, bleedChance: NONE, bruiseRate: BRUISE_LOW, knockoutFactor: 0.05, color: 0x8e8e93 },
  // Not in the design table: legs only matter for the ragdoll and stray low punches.
  legs: { id: 'legs', label: 'Legs', damageMult: 0.3, bleedChance: NONE, bruiseRate: BRUISE_LOW, knockoutFactor: 0, color: 0x636366 },
};

export const FACE_ZONE_IDS: readonly FaceZoneId[] = [
  'nose',
  'eyeLeft',
  'eyeRight',
  'brow',
  'cheekLeft',
  'cheekRight',
  'mouth',
  'jaw',
];
