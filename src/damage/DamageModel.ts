import { KNOCKOUT, PUNCH } from '../config';
import type { Impact } from './Impact';
import { ZONES, type ZoneId } from './Zones';

/** Per-zone damage state (Section 5). */
export interface ZoneState {
  /** Accumulated damage, 0..100. */
  damage: number;
  hits: number;
  /** Seconds since the last hit to this zone (Infinity if never hit). */
  sinceLastHit: number;
  /** 0..1 bruise level. */
  bruise: number;
  /** 0..1 swelling level (never recedes in a session unless healing is on). */
  swelling: number;
  /** 0..1 current bleeding severity from this zone. */
  bleed: number;
  /** Cuts opened in this zone. */
  cuts: number;
}

export interface HitResult {
  /** Damage added to the zone by this hit. */
  readonly damage: number;
  /** Knockout-meter contribution of this hit. */
  readonly knockoutContribution: number;
  /** True if this hit knocked the opponent out. */
  readonly knockout: boolean;
}

const ZONE_IDS = Object.keys(ZONES) as ZoneId[];

/**
 * Raw damage of a hit before zone multipliers. Superlinear in speed, so a
 * devastating punch is worth far more than several light ones:
 * 3 m/s ≈ 6, 5.5 m/s ≈ 18, 8 m/s ≈ 32, 10 m/s ≈ 46.
 */
export function baseDamage(speed: number): number {
  return 2.5 * Math.pow(Math.max(0, speed - 0.5), 1.3);
}

/**
 * Tracks damage per zone and the knockout meter. Head hits feed the meter
 * weighted by each zone's knockout factor (jaw highest); the meter recovers
 * slowly when the opponent isn't being hit.
 */
export class DamageModel {
  readonly zones = {} as Record<ZoneId, ZoneState>;
  /** 0..100; reaching 100 (or one hit above the single-hit threshold) is a knockout. */
  knockoutMeter = 0;
  knockedOut = false;
  private sinceHeadDamage = Infinity;

  constructor() {
    for (const id of ZONE_IDS) {
      this.zones[id] = { damage: 0, hits: 0, sinceLastHit: Infinity, bruise: 0, swelling: 0, bleed: 0, cuts: 0 };
    }
  }

  /** Overall battering 0..1 (drives heavier breathing). */
  get fatigue(): number {
    let total = 0;
    for (const id of ZONE_IDS) total += this.zones[id].damage * ZONES[id].knockoutFactor;
    return Math.min(1, total / 250 + this.knockoutMeter / 200);
  }

  applyHit(impact: Impact): HitResult {
    const zone = ZONES[impact.zone];
    const surface = impact.surface === 'openHand' ? PUNCH.openHandMultiplier : 1;
    const damage = baseDamage(impact.speed) * zone.damageMult * surface * impact.gear.damageMult;
    const state = this.zones[impact.zone];
    state.damage = Math.min(100, state.damage + damage);
    state.hits++;
    state.sinceLastHit = 0;

    const knockoutContribution = (damage * zone.knockoutFactor) / KNOCKOUT.toughness;
    let knockout = false;
    if (!this.knockedOut) {
      this.knockoutMeter = Math.min(100, this.knockoutMeter + knockoutContribution);
      if (zone.knockoutFactor >= 0.5) this.sinceHeadDamage = 0;
      if (knockoutContribution >= KNOCKOUT.singleHitThreshold || this.knockoutMeter >= 100) {
        this.knockedOut = true;
        knockout = true;
      }
    }
    return { damage, knockoutContribution, knockout };
  }

  update(dt: number): void {
    for (const id of ZONE_IDS) this.zones[id].sinceLastHit += dt;
    this.sinceHeadDamage += dt;
    if (!this.knockedOut && this.sinceHeadDamage > KNOCKOUT.meterRecoveryDelay) {
      this.knockoutMeter = Math.max(0, this.knockoutMeter - KNOCKOUT.meterRecoveryPerSecond * dt);
    }
  }

  /** Clean slate (Reset Opponent). */
  reset(): void {
    for (const id of ZONE_IDS) {
      const z = this.zones[id];
      z.damage = 0;
      z.hits = 0;
      z.sinceLastHit = Infinity;
      z.bruise = 0;
      z.swelling = 0;
      z.bleed = 0;
      z.cuts = 0;
    }
    this.knockoutMeter = 0;
    this.knockedOut = false;
    this.sinceHeadDamage = Infinity;
  }
}
