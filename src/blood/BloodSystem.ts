import type RAPIER from '@dimforge/rapier3d-compat';
import {
  type Camera,
  FrontSide,
  Matrix4,
  type MeshStandardMaterial,
  Ray,
  type Scene,
  Vector3,
  Vector4,
  type WebGLRenderer,
} from 'three';
import type { AudioSystem } from '../audio/AudioSystem';
import type { Physics } from '../core/Physics';
import { bloodScale, type SettingsStore } from '../core/Settings';
import type { DamageModel, HitResult } from '../damage/DamageModel';
import { type Impact, tierIndex } from '../damage/Impact';
import type { CutEvent } from '../damage/InjurySystem';
import type { ZoneId } from '../damage/Zones';
import type { CanonicalBone, SurfaceProxy } from '../opponent/HumanoidRig';
import type { Opponent } from '../opponent/Opponent';
import type { PlayerHands } from '../player/PlayerHands';
import { BLOOD_MAP, BLOOD_TINTS, type SkinSurface } from '../skin/SkinSurface';
import { StampKind } from '../skin/SurfacePainter';
import { BloodCoating } from './BloodCoating';
import { BloodParticles } from './BloodParticles';
import type { FloorBlood } from './FloorBlood';
import { BloodLedger, SurfaceFlow } from './SurfaceFlow';
import type { VisorSplatter } from './VisorSplatter';

/** A place that keeps bleeding: nostrils, a split lip, a cut (Sections 6, 8.5). */
interface BleedSource {
  readonly kind: 'nose' | 'mouth' | 'cut';
  readonly zone: ZoneId;
  readonly surface: SurfaceProxy;
  /** Bind-space emission points (two nostrils, or one). */
  readonly points: Vector3[];
  severity: number;
  nextEmit: number;
}

const SKIN_DRY_TIME = 90;
const TORSO_BONES: ReadonlySet<CanonicalBone> = new Set(['Spine', 'Spine1', 'Spine2', 'Hips']);
const HEAD_BONES: ReadonlySet<CanonicalBone> = new Set(['Head', 'Neck', 'Jaw']);

const _v = new Vector3();
const _w = new Vector3();
const _bind = new Vector3();
const _local = new Vector3();
const _m = new Matrix4();
const _ray = new Ray();
const _tangent = new Vector3();
const _dir = new Vector3();
const _glove = new Vector3();

/**
 * Everything blood (Sections 6–7): bleed sources (nosebleed, split lip, cuts)
 * feed runners that stream down the skin and drip off as beads; droplets fly
 * from splatter, drips and breath; drops paint the skin, the floor and the
 * player's gloves. All amounts scale with the gore setting (0 = no blood).
 */
export class BloodSystem {
  readonly particles: BloodParticles;
  readonly flow: SurfaceFlow;
  private readonly ledger = new BloodLedger();
  private readonly sources: BleedSource[] = [];
  private readonly nostrils: Vector3[] = [];
  private readonly mouthCorners: Vector3[] = [];
  private readonly unit: number;
  private time = 0;
  /** Pending little exhale sprays after heavy hits to a bleeding nose. */
  private breathSprays: number[] = [];
  private dripSoundBudget = 0;
  /** Blood on the opponent's own gloves (bind space of his gear mesh), if his rig has them. */
  private readonly opponentGloves: BloodCoating | null = null;

  constructor(
    scene: Scene,
    physics: Physics,
    private readonly opponent: Opponent,
    private readonly hands: PlayerHands,
    private readonly skin: SkinSurface,
    readonly floor: FloorBlood,
    private readonly audio: AudioSystem,
    private readonly settings: SettingsStore,
    private readonly damage: DamageModel,
    private readonly camera: Camera,
    private readonly visor: VisorSplatter,
  ) {
    this.unit = 1 / opponent.metersPerBindUnit;
    this.particles = new BloodParticles(scene, physics, 400, opponent.rig.root.position);
    this.flow = new SurfaceFlow(scene, skin, this.ledger, this.unit, (world, radius) => {
      this.particles.spawn(world, _v.set((Math.random() - 0.5) * 0.05, -0.25, (Math.random() - 0.5) * 0.05), radius);
    });
    this.locateFaceSources();
    const gear = opponent.rig.skinnedMeshes.find((m) => m.name === 'opponent-gear');
    if (gear) {
      this.opponentGloves = new BloodCoating(opponent.metersPerBindUnit);
      this.opponentGloves.attach(gear.material as MeshStandardMaterial);
    }
    settings.subscribe((s) => {
      const tint = BLOOD_TINTS[s.bloodColor];
      this.particles.setColor(tint);
      this.flow.setColor(tint);
      this.floor.setTint(tint, bloodScale(s) > 0);
      this.visor.setColor(tint);
      for (const hand of hands.both) hand.coating.setTint(tint);
      this.opponentGloves?.setTint(tint);
    });
  }

  private get scale(): number {
    return bloodScale(this.settings.current);
  }

  setParticleCapacity(capacity: number): void {
    this.particles.setCapacity(capacity);
  }

  /** Reacts to a hit: nosebleeds, split lips, splatter and blood transfer to/from the gloves. */
  onImpact(impact: Impact, _result: HitResult): void {
    const scale = this.scale;
    if (scale <= 0) return;
    const tier = tierIndex(impact.tier);
    const bleedMult = impact.gear.bleedMult;
    this.opponent.toBind(impact.point, impact.bone, _bind);

    if (impact.zone === 'nose') this.noseHit(impact, tier, bleedMult);
    if (impact.zone === 'mouth' && tier >= 2 && Math.random() < 0.35 * bleedMult) {
      this.startSource('mouth', 'mouth', this.nearest(this.mouthCorners, _bind), 0.4 + 0.15 * tier);
    }

    // Splatter (Section 7.6): hitting a bleeding or blood-covered area throws blood
    // along the punch; the more blood already on the skin (and on the glove), the bigger the spray.
    const hand = this.hands.get(impact.side);
    const bleeding = this.bleedingAt(impact.zone);
    const surfaceBlood = this.ledger.query(_bind, 0.04 * this.unit, SKIN_DRY_TIME);
    const bloody = bleeding + surfaceBlood + 0.3 * hand.coating.load;
    if (bloody > 0.05) this.splatter(impact, Math.min(2.5, bloody), bleedMult, scale);

    // His guard: a bloody glove or fist leaves its blood on his gloves.
    if ((impact.bone === 'LeftHand' || impact.bone === 'RightHand') && hand.coating.load > 0.05 && this.opponentGloves) {
      const taken = hand.coating.take(0.25);
      _dir.crossVectors(impact.direction, _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)).normalize();
      this.opponentGloves.splash(_bind, 0.02 * this.unit, Math.min(1, 0.3 + taken), _dir, 2);
    }

    // Transfer (Section 7.5): blood under the punch smears onto the glove/knuckles, with
    // fine specks flicked around it; harder punches into more blood leave bigger marks.
    const wetHere = Math.min(1.5, surfaceBlood + bleeding);
    if (wetHere > 0.03) {
      hand.surfacePoint(impact.point, _local);
      // Smeared across the knuckles, sideways to the punch.
      _dir.crossVectors(impact.direction, _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)).normalize();
      hand.worldDirToMesh(_dir, _tangent);
      const glove = impact.gear.kind === 'glove';
      const radius = (glove ? 0.02 : 0.013) * (0.8 + 0.25 * tier) * (0.8 + 0.4 * Math.min(1, wetHere));
      const specks = Math.round(1 + tier + 3 * Math.min(1, wetHere) * Math.random());
      hand.coating.splash(_local, radius, Math.min(1, 0.25 + wetHere * 0.6), _tangent, specks);
    } else if (hand.coating.load > 0.08) {
      // ...and a bloody glove prints onto clean skin.
      const taken = hand.coating.take(0.35);
      this.skin.queue(BLOOD_MAP, {
        kind: StampKind.Sphere,
        a: _bind.clone(),
        radius: impact.gear.brushRadius * 0.9 * this.unit,
        hardness: 0.25,
        value: new Vector4(Math.min(0.55, taken * 1.5) * scale, 0.8, 0, 0),
      });
      this.ledger.add(_bind, taken * 0.5);
    }
  }

  /** A cut opened (InjurySystem): it bleeds into the flow — brow cuts run down into the eye. */
  addCut(cut: CutEvent): void {
    if (this.scale <= 0) return;
    const surface = this.opponent.rig.headProxies[0];
    if (!surface) return;
    this.startSource('cut', cut.zone, [cut.bindPoint.clone()], cut.severity, surface);
  }

  update(dt: number, renderer: WebGLRenderer): void {
    this.time += dt;
    this.ledger.tick(dt);
    const scale = this.scale;
    const s = this.settings.current;

    // Sources emit runners; severities decay (light bleeds stop in ~30 s, heavy ones last minutes).
    for (let i = this.sources.length - 1; i >= 0; i--) {
      const src = this.sources[i];
      const heal = s.healing ? 2 : 1;
      src.severity -= dt * (0.006 + 0.008 * (1 - src.severity)) * heal;
      this.damage.zones[src.zone].bleed = Math.max(0, src.severity);
      if (src.severity <= 0.02 || scale <= 0) {
        this.sources.splice(i, 1);
        continue;
      }
      if (this.time >= src.nextEmit) {
        const point = src.points[Math.floor(Math.random() * src.points.length)];
        this.flow.startRunner(src.surface, point, (0.3 + 0.5 * src.severity) * Math.max(0.4, scale));
        // Heavy: a couple of runners a second (several drips); light: one every few seconds.
        src.nextEmit = this.time + 1 / (0.3 + 2.2 * src.severity * scale);
      }
    }

    // Breath effect: little sprays from the nostrils on hard exhales after heavy hits.
    for (let i = this.breathSprays.length - 1; i >= 0; i--) {
      if (this.time < this.breathSprays[i]) continue;
      this.breathSprays.splice(i, 1);
      this.breathSpray(scale);
    }

    if (this.opponent.state !== 'knockedOut') this.flow.update(dt, scale);
    if (scale > 0) this.bloodyOwnGloves(dt);
    this.opponentGloves?.update(dt, s.dryingSpeed);
    this.dripSoundBudget = Math.min(6, this.dripSoundBudget + dt * 6);
    this.particles.update(dt, {
      floor: (x, z, velocity, radius) => {
        this.floor.splat(x, z, velocity, radius, (radius / 0.0035) * scale);
        if (this.dripSoundBudget >= 1 && radius > 0.002) {
          this.dripSoundBudget -= 1;
          this.audio.playDrip(_w.set(x, 0, z), Math.min(1, velocity.length() / 5));
        }
      },
      opponent: (collider, origin, velocity, step, radius) => this.dropOnOpponent(collider, origin, velocity, step, radius, scale),
      player: (point, radius) => this.dropOnPlayer(point, radius),
      visor: (point, velocity) => s.visorSplatter && this.visor.hit(point, velocity, this.camera),
    });
    this.floor.update(renderer, dt, s.dryingSpeed);
  }

  /** Reset Opponent: stop all bleeding and flows (paint is cleared by the skin surface). */
  resetOpponent(): void {
    this.sources.length = 0;
    this.flow.clear();
    this.ledger.clear();
    this.breathSprays.length = 0;
    for (const hand of this.hands.both) hand.coating.clear();
    this.opponentGloves?.clear();
  }

  /**
   * His gloves pick up his own blood when they are held against a bleeding
   * face (high guard, covering up): the side of the glove facing the wound
   * gets dabbed now and then.
   */
  private bloodyOwnGloves(dt: number): void {
    if (!this.opponentGloves || this.sources.length === 0) return;
    for (const side of ['Left', 'Right'] as const) {
      const hand = this.opponent.rig.bones[`${side}Hand`];
      const tip = this.opponent.rig.bones[`${side}HandTip`];
      hand.getWorldPosition(_glove);
      if (tip) _glove.lerp(tip.getWorldPosition(_v), 0.6);
      for (const src of this.sources) {
        const wound = this.opponent.fromBind(src.points[0], 'Head', _w);
        const distance = wound.distanceTo(_glove);
        if (distance > 0.14 || Math.random() > dt * 2.5 * src.severity) continue;
        // The glove surface facing the wound.
        _v.subVectors(wound, _glove).normalize();
        _local.copy(_glove).addScaledVector(_v, 0.055);
        this.opponent.toBind(_local, `${side}Hand`, _bind);
        _dir.set(0, -1, 0); // runs down the glove
        this.opponentGloves.add(_bind, (0.008 + 0.012 * src.severity) * this.unit, 0.35 + 0.5 * src.severity, { direction: _dir, stretch: 1.6 });
      }
    }
  }

  cleanFloor(renderer: WebGLRenderer): void {
    this.floor.clear(renderer);
    this.particles.clear();
  }

  // ---------------------------------------------------------------------------

  /**
   * Nosebleed (Section 6): medium-or-harder nose hits may start one; the
   * chance grows with force and accumulated nose damage, and a devastating
   * hit always does. Further hits intensify it. Straight shots open both
   * nostrils, angled ones the far nostril only.
   */
  private noseHit(impact: Impact, tier: number, bleedMult: number): void {
    if (tier < 1) return;
    const nose = this.damage.zones.nose;
    const chance = tier === 3 ? 1 : (0.3 + 0.12 * (impact.speed - 3) + nose.damage / 200) * bleedMult;
    const existing = this.sources.find((s) => s.kind === 'nose');
    if (!existing && Math.random() >= chance) return;
    // Which nostrils: lateral component of the punch relative to the head.
    const head = this.opponent.rig.bones.Head;
    _m.extractRotation(head.matrixWorld).invert();
    const lateral = _v.copy(impact.direction).applyMatrix4(_m).x;
    const points = Math.abs(lateral) > 0.5 && this.nostrils.length === 2 ? [this.nostrils[lateral > 0 ? 0 : 1]] : this.nostrils;
    const gain = (0.28 + 0.18 * tier) * bleedMult;
    if (existing) {
      existing.severity = Math.min(1, existing.severity + gain);
      for (const p of points) if (!existing.points.includes(p)) existing.points.push(p);
    } else {
      this.startSource('nose', 'nose', points, gain);
    }
    if (tier >= 2) {
      // A few hard exhales over the next seconds spray a little blood.
      for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) this.breathSprays.push(this.time + 0.6 + Math.random() * 5);
    }
  }

  private startSource(kind: BleedSource['kind'], zone: ZoneId, points: Vector3[], severity: number, surface?: SurfaceProxy): void {
    const proxy = surface ?? this.opponent.rig.headProxies[0];
    if (!proxy || points.length === 0) return;
    const existing = kind === 'cut' ? undefined : this.sources.find((s) => s.kind === kind);
    if (existing) {
      existing.severity = Math.min(1, existing.severity + severity);
      return;
    }
    this.sources.push({ kind, zone, surface: proxy, points, severity: Math.min(1, severity), nextEmit: this.time });
    this.damage.zones[zone].bleed = Math.max(this.damage.zones[zone].bleed, severity);
  }

  /** Current bleeding severity at a zone (nose, mouth, a cut there). */
  private bleedingAt(zone: ZoneId): number {
    let s = 0;
    for (const src of this.sources) if (src.zone === zone) s = Math.max(s, src.severity);
    return s;
  }

  /**
   * Impact splatter (Section 7.6): the punch drives blood off the struck
   * surface — sprayed in a cone around the punch direction projected along
   * the skin (it can't go through the head), lifted off the surface, at a
   * fraction of the punch speed. Lands on the floor, the body and the gloves.
   */
  private splatter(impact: Impact, bloody: number, bleedMult: number, scale: number): void {
    const strength = Math.min(1, (impact.speed - 1) / 8);
    // Wet blood flies off whatever hits it, so the gear damps it only slightly.
    const count = Math.round((10 + 50 * strength) * Math.pow(bloody, 0.8) * scale * Math.sqrt(bleedMult));
    // Hard shots on a soaked face also throw a fine, fast mist.
    const mist = strength > 0.45 && bloody > 0.6 ? Math.round(count * 0.5) : 0;
    for (let i = 0; i < mist; i++) {
      _v.copy(impact.normal)
        .multiplyScalar(0.6)
        .addScaledVector(impact.direction, 0.5)
        .add(_w.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).multiplyScalar(1.4))
        .normalize()
        .multiplyScalar(impact.speed * (0.35 + Math.random() * 0.45));
      _w.copy(impact.point).addScaledVector(impact.normal, 0.015);
      this.particles.spawn(_w, _v, 0.0005 + Math.random() * 0.0008);
    }
    const n = impact.normal;
    // Tangential part of the punch direction (along the skin, away from the fist).
    _tangent.copy(impact.direction).addScaledVector(n, -impact.direction.dot(n));
    if (_tangent.lengthSq() < 1e-4) _tangent.set(0, 1, 0).addScaledVector(n, -n.y);
    _tangent.normalize();
    for (let i = 0; i < count; i++) {
      _v.copy(_tangent)
        .addScaledVector(n, 0.35 + Math.random() * 0.5)
        .addScaledVector(impact.direction, 0.25)
        .add(_w.set(Math.random() - 0.5, Math.random() * 0.5, Math.random() - 0.5).multiplyScalar(1.1))
        .normalize()
        .multiplyScalar(impact.speed * (0.22 + Math.random() * 0.4));
      _w.copy(impact.point).addScaledVector(n, 0.015);
      this.particles.spawn(_w, _v, 0.001 + Math.random() * 0.0026);
    }
  }

  private breathSpray(scale: number): void {
    const nose = this.sources.find((s) => s.kind === 'nose');
    const surface = this.opponent.rig.headProxies[0];
    if (!nose || !surface || scale <= 0 || this.opponent.state === 'knockedOut') return;
    const head = this.opponent.rig.bones.Head;
    const forward = _w.set(0, 0, 1).transformDirection(head.matrixWorld);
    for (const point of nose.points) {
      const world = this.opponent.fromBind(point, 'Head', new Vector3());
      const n = Math.round((3 + 4 * nose.severity) * scale);
      for (let i = 0; i < n; i++) {
        _v.copy(forward)
          .multiplyScalar(1 + Math.random() * 1.4)
          .add(new Vector3((Math.random() - 0.5) * 0.6, -0.3 - Math.random() * 0.4, (Math.random() - 0.5) * 0.6));
        this.particles.spawn(world, _v, 0.0008 + Math.random() * 0.0012);
      }
    }
  }

  /**
   * A droplet reached an opponent hitbox. On the head and torso the hitboxes
   * are coarse, so the landing is confirmed by raycasting the real skin
   * surface (a drop leaving a nostril must fall onto the lip, not stick inside
   * the face's collision sphere). Where it lands it stains the skin; on the
   * head or chest it then runs; fast drops sometimes splash on towards the floor.
   */
  private dropOnOpponent(
    collider: RAPIER.Collider,
    origin: Vector3,
    velocity: Vector3,
    step: number,
    radius: number,
    scale: number,
  ): boolean {
    const info = this.opponent.hitboxes.lookup(collider);
    if (!info) return true;
    const surface = TORSO_BONES.has(info.bone)
      ? this.opponent.rig.torsoProxies[0]
      : HEAD_BONES.has(info.bone)
        ? this.opponent.rig.headProxies[0]
        : undefined;
    if (surface) {
      // Ray in the surface's bind space.
      _m.multiplyMatrices(surface.bone.matrixWorld, surface.boneInverse).multiply(surface.bindMatrix).invert();
      _ray.origin.copy(origin).applyMatrix4(_m);
      _ray.direction.copy(velocity).normalize().transformDirection(_m);
      const hit = surface.bvh.raycastFirst(_ray, FrontSide, 0.0005 * this.unit, (step + radius) * this.unit);
      if (!hit) return false; // still falling
      _bind.copy(hit.point);
    } else {
      this.opponent.toBind(_w.copy(origin).addScaledVector(_v.copy(velocity).normalize(), step), info.bone, _bind);
    }

    const amount = Math.min(0.6, (radius / 0.003) * 0.3) * scale;
    this.skin.queue(BLOOD_MAP, {
      kind: StampKind.Sphere,
      a: _bind.clone(),
      radius: (radius * 2.2 + 0.002) * this.unit,
      hardness: 0.4,
      value: new Vector4(amount, 1, 0, 0),
    });
    this.ledger.add(_bind, amount);
    if (surface && radius > 0.0022 && velocity.y < 0) {
      this.flow.startRunner(surface, _bind, 0.25 + (radius / 0.004) * 0.2);
    }
    // A fast drop sometimes splashes: a smaller drop carries on, deflected outwards.
    const speed = velocity.length();
    if (speed > 1.6 && radius > 0.0018 && Math.random() < 0.35) {
      const world = surface ? _w.copy(_bind).applyMatrix4(_m.invert()) : _w.copy(origin);
      const out = _v.set(velocity.x * 0.3 + (Math.random() - 0.5) * 0.4, -0.3, velocity.z * 0.3 + (Math.random() - 0.5) * 0.4);
      // Nudge away from the body so it doesn't immediately land again.
      world.addScaledVector(_local.copy(velocity).setY(0).normalize(), -0.02);
      this.particles.spawn(world, out, radius * 0.6);
    }
    return true;
  }

  /** A droplet hit a fist or glove: it sticks (Section 7.5/7.6). */
  private dropOnPlayer(point: Vector3, radius: number): boolean {
    for (const hand of this.hands.both) {
      if (!hand.tracked) continue;
      if (hand.strikePoint.distanceTo(point) > hand.gear.strikeRadius * 1.3 + radius) continue;
      hand.surfacePoint(point, _local);
      hand.coating.add(_local, 0.004 + radius * 1.6, 0.55);
      return true;
    }
    return false;
  }

  /** Finds nostrils and mouth corners on the head surface (works for any rig). */
  private locateFaceSources(): void {
    const surface = this.opponent.rig.headProxies[0];
    if (!surface) return;
    const s = this.opponent.rig.height / 1.8;
    const snap = (x: number, y: number, z: number): Vector3 => {
      const bind = this.opponent.characterRestToBind(new Vector3(x * s, y * s, z * s).add(this.opponent.rig.headCenter), 'Head');
      const hit = surface.bvh.closestPointToPoint(bind);
      return hit ? hit.point.clone() : bind;
    };
    this.nostrils.push(snap(0.0085, -0.054, 0.104), snap(-0.0085, -0.054, 0.104));
    this.mouthCorners.push(snap(0.024, -0.075, 0.09), snap(-0.024, -0.075, 0.09), snap(0, -0.082, 0.096));
  }

  private nearest(points: readonly Vector3[], to: Vector3): Vector3[] {
    let best = points[0];
    for (const p of points) if (p.distanceTo(to) < best.distanceTo(to)) best = p;
    return best ? [best] : [];
  }
}
