import type { AudioSystem } from '../audio/AudioSystem';
import type { ImpactSurface } from '../audio/SoundBank';
import { debugStats } from '../debug/DebugStats';
import type { XRInput } from '../input/XRInput';
import type { Opponent } from '../opponent/Opponent';
import type { DamageModel, HitResult } from './DamageModel';
import { type Impact, type PunchType, tierIndex } from './Impact';
import { FACE_ZONE_IDS, type FaceZoneId, ZONES } from './Zones';

/** Session punch statistics (the stats panel arrives in Milestone 9). */
export interface PunchStats {
  punches: number;
  strongest: number;
  readonly byType: Record<PunchType, number>;
}

const TIER_LABEL = ['Light', 'Medium', 'Heavy', 'Devastating'];

/**
 * Routes every registered hit to the systems that respond to it: damage and
 * knockout, physical reaction or ragdoll, impact sound and vocalisation,
 * controller haptics, statistics and the debug "last impact" readout.
 * Later milestones add bruising, swelling, bleeding and blood transfer here.
 */
export class HitPipeline {
  readonly stats: PunchStats = { punches: 0, strongest: 0, byType: { jab: 0, cross: 0, hook: 0, uppercut: 0, slap: 0 } };
  lastImpact: Impact | null = null;
  lastResult: HitResult | null = null;
  /** Systems that react to every hit after damage is applied (injuries, blood...). */
  private readonly listeners: Array<(impact: Impact, result: HitResult) => void> = [];

  constructor(
    private readonly damage: DamageModel,
    private readonly opponent: Opponent,
    private readonly audio: AudioSystem,
    private readonly input: XRInput,
  ) {}

  onHit(listener: (impact: Impact, result: HitResult) => void): void {
    this.listeners.push(listener);
  }

  handle(impact: Impact): void {
    const result = this.damage.applyHit(impact);
    // Paint and bleed against the pose the punch landed on, before the reaction moves him.
    for (const listener of this.listeners) listener(impact, result);
    this.opponent.hit(impact, result.knockout);

    const tier = tierIndex(impact.tier);
    this.audio.playImpact(this.surfaceSound(impact), tier, impact.point);
    if (result.knockout) {
      this.audio.playGroan();
    } else if (this.opponent.state === 'standing') {
      const gruntChance = tier >= 2 ? 0.75 : tier === 1 ? 0.2 : 0;
      if (Math.random() < gruntChance) this.audio.playGrunt(tier / 3);
    }

    // Controller vibration scaled to impact strength and duration (Section 4).
    const strength = Math.min(1, Math.max(0, (impact.speed - 1) / 9));
    const haptic = impact.gear.hapticMult;
    this.input.pulse(impact.side, Math.min(1, (0.25 + 0.75 * strength) * haptic), (15 + 70 * strength) * haptic);

    this.stats.punches++;
    this.stats.strongest = Math.max(this.stats.strongest, impact.handSpeed);
    this.stats.byType[impact.punchType]++;
    this.lastImpact = impact;
    this.lastResult = result;

    const uv = impact.uv ? ` uv ${impact.uv.x.toFixed(2)},${impact.uv.y.toFixed(2)}` : '';
    debugStats.lastHit =
      `${TIER_LABEL[tier]} ${impact.punchType} → ${ZONES[impact.zone].label} ` +
      `${impact.speed.toFixed(1)} m/s · dmg ${result.damage.toFixed(1)}${uv}` +
      (result.knockout ? ' · KO!' : '');
  }

  /** Publishes the knockout meter for the HUD. */
  updateDebug(): void {
    const head = FACE_ZONE_IDS.reduce((sum, id) => sum + this.damage.zones[id].damage, this.damage.zones.head.damage);
    const n = this.stats.punches;
    debugStats.knockout =
      `KO ${this.damage.knockoutMeter.toFixed(0)}% · head ${head.toFixed(0)} · ` +
      `${n} ${n === 1 ? 'punch' : 'punches'} · best ${this.stats.strongest.toFixed(1)} m/s`;
  }

  resetStats(): void {
    this.stats.punches = 0;
    this.stats.strongest = 0;
    for (const key of Object.keys(this.stats.byType) as PunchType[]) this.stats.byType[key] = 0;
    this.lastImpact = null;
    this.lastResult = null;
    debugStats.lastHit = '';
  }

  private surfaceSound(impact: Impact): ImpactSurface {
    if (impact.surface === 'openHand') return 'slap';
    if (impact.gear.kind === 'glove') return 'glove';
    return impact.zone === 'head' || FACE_ZONE_IDS.includes(impact.zone as FaceZoneId) ? 'face' : 'body';
  }
}
