import { Vector3, Vector4 } from 'three';
import { bloodScale, type SettingsStore } from '../core/Settings';
import type { Opponent } from '../opponent/Opponent';
import { BLOOD_MAP, DAMAGE_MAP, type SkinSurface } from '../skin/SkinSurface';
import { StampKind } from '../skin/SurfacePainter';
import type { DamageModel, HitResult } from './DamageModel';
import { type Impact, tierIndex } from './Impact';
import { type FaceZoneId, ZONES, type ZoneId } from './Zones';

/** A freshly opened cut (Section 8.5): becomes a bleed source. */
export interface CutEvent {
  readonly zone: ZoneId;
  /** Cut centre in the paint surfaces' bind space. */
  readonly bindPoint: Vector3;
  readonly severity: number;
}

/** Bruise brush spread by zone (bodies bruise wider than faces). */
const SPREAD: Partial<Record<ZoneId, number>> = { head: 1.2, torso: 1.7, stomach: 1.7, arms: 1.3, legs: 1.5 };
/** How readily each zone swells. */
const SWELL: Partial<Record<ZoneId, number>> = {
  eyeLeft: 1,
  eyeRight: 1,
  cheekLeft: 0.6,
  cheekRight: 0.6,
  mouth: 0.6,
  nose: 0.35,
  brow: 0.45,
  jaw: 0.25,
  head: 0.2,
};
/** Base chance of a heavy bare-knuckle shot opening a cut, and the cut's shape. */
const CUTS: Partial<Record<FaceZoneId, { chance: number; length: number; dir: Vector3 }>> = {
  brow: { chance: 0.5, length: 0.022, dir: new Vector3(1, 0.12, 0) },
  cheekLeft: { chance: 0.28, length: 0.018, dir: new Vector3(1, 0.35, 0) },
  cheekRight: { chance: 0.28, length: 0.018, dir: new Vector3(1, -0.35, 0) },
  mouth: { chance: 0.42, length: 0.011, dir: new Vector3(0.15, 1, 0) },
};

const _bind = new Vector3();
const _a = new Vector3();
const _b = new Vector3();

/**
 * Turns hits into visible injuries (Section 8): bruises painted with a soft
 * brush sized by the gear (gloves wide and soft, knuckles tight), swelling,
 * black eyes following the eye socket that swell the eye shut, and cuts.
 * Also keeps the per-zone bruise/swelling state on the CPU (no GPU readback).
 */
export class InjurySystem {
  /** Called when a cut opens; the blood system turns it into a bleed source. */
  onCut: ((cut: CutEvent) => void) | null = null;

  constructor(
    private readonly skin: SkinSurface,
    private readonly opponent: Opponent,
    private readonly damage: DamageModel,
    private readonly settings: SettingsStore,
  ) {}

  onImpact(impact: Impact, result: HitResult): void {
    const s = this.settings.current;
    const zone = ZONES[impact.zone];
    const state = this.damage.zones[impact.zone];
    const gear = impact.gear;
    const unit = 1 / this.opponent.metersPerBindUnit;
    this.opponent.toBind(impact.point, impact.bone, _bind);

    if (s.bruising) {
      // Bruise: amount from damage, the zone's bruise rate and the gear.
      // Kept well below 1 per hit so repeated hits build up gradually instead of clipping.
      const amount = Math.min(1, Math.max(0.08, result.damage / 35)) * zone.bruiseRate * gear.bruiseMult * 0.6;
      const radius = gear.brushRadius * (SPREAD[impact.zone] ?? 1) * unit;
      this.skin.queue(DAMAGE_MAP, {
        kind: StampKind.Sphere,
        a: _bind.clone(),
        radius,
        hardness: gear.brushHardness,
        value: new Vector4(amount, 0.9, 0, 0),
      });
      state.bruise = Math.min(1, state.bruise + amount);

      const swellFactor = SWELL[impact.zone] ?? 0;
      if (swellFactor > 0) {
        const swell = Math.min(1, result.damage / 45) * swellFactor * gear.swellMult * 0.28;
        this.skin.queue(DAMAGE_MAP, {
          kind: StampKind.Sphere,
          a: _bind.clone(),
          radius: radius * 1.6,
          hardness: 0,
          value: new Vector4(0, 0, swell, 0),
        });
        state.swelling = Math.min(1, state.swelling + (1 - state.swelling) * swell * 2.4);
      }

      if (impact.zone === 'eyeLeft' || impact.zone === 'eyeRight') this.blackEye(impact.zone, amount, result.damage, gear.swellMult);
    }

    this.maybeCut(impact, s.bloodColor !== 'off' ? bloodScale(s) : 0);
  }

  /**
   * Black eye (Section 8.3): a ring around the socket — heaviest under the eye
   * and on the upper lid — plus swelling of both lids that closes the eye.
   */
  private blackEye(zone: 'eyeLeft' | 'eyeRight', amount: number, damage: number, swellMult: number): void {
    const eye = this.opponent.eyeBindPosition(zone === 'eyeLeft' ? 'Left' : 'Right', _a);
    if (!eye) return;
    const unit = 1 / this.opponent.metersPerBindUnit;
    this.skin.queue(DAMAGE_MAP, {
      kind: StampKind.Ring,
      a: eye.clone(),
      radius: 0.036 * unit,
      hardness: 0.5,
      value: new Vector4(Math.min(1, amount * 1.3), 0.9, 0, 0),
    });
    const lidSwell = Math.min(1, damage / 40) * swellMult * 0.4;
    for (const dy of [0.011, -0.013]) {
      this.skin.queue(DAMAGE_MAP, {
        kind: StampKind.Sphere,
        a: _b.copy(eye).add(new Vector3(0, dy * unit, 0.004 * unit)).clone(),
        radius: 0.02 * unit,
        hardness: 0,
        value: new Vector4(0, 0, lidSwell, 0),
      });
    }
  }

  /** Heavy bare-knuckle shots to the brow, cheekbone or lip can split the skin. */
  private maybeCut(impact: Impact, bloodAmount: number): void {
    const shape = CUTS[impact.zone as FaceZoneId];
    if (!shape || bloodAmount <= 0 || tierIndex(impact.tier) < 2) return;
    const chance = shape.chance * impact.gear.cutMult * Math.min(1, (impact.speed - 5) / 3);
    if (Math.random() >= chance) return;

    const unit = 1 / this.opponent.metersPerBindUnit;
    const half = _a.copy(shape.dir).normalize().multiplyScalar((shape.length * unit) / 2);
    const center = _bind.clone();
    this.skin.queue(DAMAGE_MAP, {
      kind: StampKind.Segment,
      a: center.clone().sub(half),
      b: center.clone().add(half),
      radius: 0.0019 * unit,
      hardness: 0.45,
      value: new Vector4(0.15, 0.6, 0.05, 1),
    });
    this.skin.queue(BLOOD_MAP, {
      kind: StampKind.Segment,
      a: center.clone().sub(half),
      b: center.clone().add(half),
      radius: 0.005 * unit,
      hardness: 0.2,
      value: new Vector4(0.6 * bloodAmount, 1, 0, 0),
    });
    const state = this.damage.zones[impact.zone];
    state.cuts++;
    const severity = Math.min(1, 0.45 + (impact.speed - 5) / 6);
    state.bleed = Math.max(state.bleed, severity);
    this.onCut?.({ zone: impact.zone, bindPoint: center, severity });
  }

  /** Eye closure from swelling (0 open .. ~0.95 swollen shut), per eye. */
  eyeClosure(zone: 'eyeLeft' | 'eyeRight'): number {
    if (!this.settings.current.bruising) return 0;
    const s = this.damage.zones[zone].swelling;
    const t = Math.min(1, Math.max(0, (s - 0.15) / 0.75));
    return t * t * (3 - 2 * t) * 0.95;
  }
}
