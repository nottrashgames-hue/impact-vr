import {
  type Color,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  type Scene,
  SphereGeometry,
  Vector3,
  Vector4,
} from 'three';
import type { HitPointInfo } from 'three-mesh-bvh';
import type { SurfaceProxy } from '../opponent/HumanoidRig';
import { BLOOD_MAP, type SkinSurface } from '../skin/SkinSurface';
import { StampKind } from '../skin/SurfacePainter';

const MAX_RUNNERS = 48;
const MAX_BEADS = 16;
/** Bead volume that detaches as one drop. */
const DROP_VOLUME = 0.22;
/** Seconds a bead takes to stretch and let go. */
const RELEASE_TIME = 0.18;

interface Runner {
  readonly surface: SurfaceProxy;
  readonly pos: Vector3;
  readonly lastPaint: Vector3;
  volume: number;
  age: number;
  still: number;
}

interface Bead {
  readonly surface: SurfaceProxy;
  readonly pos: Vector3;
  volume: number;
  /** < 0 while growing, 0..1 while stretching to let go. */
  release: number;
  idle: number;
}

/**
 * Remembers recently painted skin blood (bind space) so a punch can tell
 * whether it landed in blood — for transfer onto gloves — without reading
 * the paint texture back from the GPU.
 */
export class BloodLedger {
  private readonly points: Vector4[] = [];
  private readonly times: number[] = [];
  private head = 0;
  private now = 0;

  constructor(private readonly capacity = 600) {}

  tick(dt: number): void {
    this.now += dt;
  }

  add(bind: Vector3, amount: number): void {
    if (this.points.length < this.capacity) {
      this.points.push(new Vector4(bind.x, bind.y, bind.z, amount));
      this.times.push(this.now);
    } else {
      this.points[this.head].set(bind.x, bind.y, bind.z, amount);
      this.times[this.head] = this.now;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** Wet blood near a bind-space point (amounts fade as they dry). */
  query(bind: Vector3, radius: number, dryTime: number): number {
    let sum = 0;
    const r2 = radius * radius;
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      const dx = p.x - bind.x;
      const dy = p.y - bind.y;
      const dz = p.z - bind.z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      sum += p.w * Math.max(0, 1 - (this.now - this.times[i]) / dryTime);
    }
    return sum;
  }

  clear(): void {
    this.points.length = 0;
    this.times.length = 0;
    this.head = 0;
  }
}

const _g = new Vector3();
const _n = new Vector3();
const _t = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _s = new Vector3();
const _w = new Vector3();
const _info: HitPointInfo = { point: new Vector3(), distance: 0, faceIndex: 0 };
const DOWN = new Vector3(0, -1, 0);
const HIDDEN = new Matrix4().makeScale(0, 0, 0);

/**
 * Blood running over the skin (Sections 6 and 7.2/7.4). Each "runner" carries
 * a volume of blood across a bind-space copy of the head or torso: every step
 * it snaps to the surface, slides along gravity projected onto the surface
 * (so streaks follow the head's tilt), paints a thinning streak and loses
 * volume. Where the surface turns to face down (nose tip, lip edge, under the
 * chin) it feeds a bead that visibly grows, stretches and lets go as a drop.
 */
export class SurfaceFlow {
  private readonly runners: Runner[] = [];
  private readonly beads: Bead[] = [];
  readonly beadMesh: InstancedMesh;
  private readonly material: MeshStandardMaterial;

  /**
   * @param unit bind units per metre
   * @param onDrip spawns a falling droplet (world position, radius in metres)
   */
  constructor(
    scene: Scene,
    private readonly skin: SkinSurface,
    private readonly ledger: BloodLedger,
    private readonly unit: number,
    private readonly onDrip: (world: Vector3, radius: number) => void,
  ) {
    this.material = new MeshStandardMaterial({ name: 'blood-bead', roughness: 0.08, metalness: 0 });
    this.beadMesh = new InstancedMesh(new SphereGeometry(1, 10, 8), this.material, MAX_BEADS);
    this.beadMesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.beadMesh.count = 0;
    this.beadMesh.frustumCulled = false;
    this.beadMesh.name = 'blood-beads';
    scene.add(this.beadMesh);
  }

  get activeRunners(): number {
    return this.runners.length;
  }

  setColor(color: Color): void {
    this.material.color.copy(color).multiplyScalar(1.6);
  }

  /** Starts blood flowing from a bind-space point on a surface. */
  startRunner(surface: SurfaceProxy, bind: Vector3, volume: number): void {
    if (this.runners.length >= MAX_RUNNERS) this.runners.shift();
    surface.bvh.closestPointToPoint(bind, _info);
    this.runners.push({
      surface,
      pos: _info.point.clone(),
      lastPaint: _info.point.clone(),
      volume: Math.min(1.5, volume),
      age: 0,
      still: 0,
    });
  }

  update(dt: number, bloodScale: number): void {
    if (dt <= 0) return;
    for (let i = this.runners.length - 1; i >= 0; i--) {
      if (!this.stepRunner(this.runners[i], dt, bloodScale)) this.runners.splice(i, 1);
    }
    this.updateBeads(dt);
  }

  clear(): void {
    this.runners.length = 0;
    this.beads.length = 0;
    this.beadMesh.count = 0;
  }

  /** Advances one runner; returns false when it is used up or turned into a drip. */
  private stepRunner(r: Runner, dt: number, bloodScale: number): boolean {
    r.age += dt;
    if (r.age > 25 || r.volume < 0.04) return false;
    const bvh = r.surface.bvh;
    bvh.closestPointToPoint(r.pos, _info);
    r.pos.copy(_info.point);
    this.faceNormal(r.surface, _info.faceIndex, _n);

    // Gravity in the surface's bind space (follows the head/torso orientation).
    this.gravity(r.surface, _g);
    const gn = _g.dot(_n);
    if (gn > 0.55) {
      // The surface faces down here: blood collects into a hanging bead.
      this.feedBead(r.surface, r.pos, r.volume);
      return false;
    }
    _t.copy(_g).addScaledVector(_n, -gn);
    const along = _t.length();
    if (along < 0.12) {
      // Flat, upward-facing spot: it pools and stops.
      r.still += dt;
      return r.still < 1.5;
    }
    // Viscous flow: a couple of centimetres per second, faster with more blood.
    const speed = (0.018 + 0.045 * Math.min(1, r.volume)) * this.unit;
    r.pos.addScaledVector(_t.divideScalar(along), speed * dt);

    const moved = r.pos.distanceTo(r.lastPaint);
    if (moved > 0.003 * this.unit) {
      const volume = Math.min(1, r.volume);
      const amount = (0.28 + 0.45 * volume) * bloodScale;
      this.skin.queue(BLOOD_MAP, {
        kind: StampKind.Segment,
        a: r.lastPaint.clone(),
        b: r.pos.clone(),
        radius: (0.0017 + 0.0032 * volume) * this.unit,
        hardness: 0.35,
        value: new Vector4(amount, 1, 0, 0),
      });
      this.ledger.add(r.pos, amount);
      r.volume -= (moved / this.unit) * 2.4;
      r.lastPaint.copy(r.pos);
    }
    return true;
  }

  private feedBead(surface: SurfaceProxy, pos: Vector3, volume: number): void {
    const merge = 0.006 * this.unit;
    for (const bead of this.beads) {
      if (bead.surface === surface && bead.pos.distanceTo(pos) < merge) {
        bead.volume += volume;
        bead.idle = 0;
        return;
      }
    }
    if (this.beads.length >= MAX_BEADS) this.beads.shift();
    this.beads.push({ surface, pos: pos.clone(), volume, release: -1, idle: 0 });
  }

  private updateBeads(dt: number): void {
    let shown = 0;
    for (let i = this.beads.length - 1; i >= 0; i--) {
      const bead = this.beads[i];
      bead.idle += dt;
      if (bead.release < 0) {
        bead.volume -= dt * 0.01; // a stalled bead slowly dries
        if (bead.volume >= DROP_VOLUME) bead.release = 0;
      } else {
        bead.release += dt / RELEASE_TIME;
        if (bead.release >= 1) {
          this.beadWorld(bead, _w);
          this.onDrip(_w, 0.0032 + 0.0012 * Math.random());
          bead.volume -= DROP_VOLUME;
          bead.release = -1;
        }
      }
      if (bead.volume < 0.03 || bead.idle > 40) {
        this.beads.splice(i, 1);
        continue;
      }
    }
    // Draw: a drop hanging from the surface, stretching downwards as it lets go.
    for (const bead of this.beads) {
      const fill = Math.min(1, bead.volume / DROP_VOLUME);
      const stretch = bead.release < 0 ? 0 : bead.release;
      const r = 0.0009 + 0.0014 * fill;
      this.beadWorld(bead, _w);
      _w.y -= r * (0.5 + stretch * 1.2);
      _m.compose(_w, _q.identity(), _s.set(r, r * (1 + stretch * 1.8), r));
      this.beadMesh.setMatrixAt(shown++, _m);
    }
    for (let i = shown; i < this.beadMesh.count; i++) this.beadMesh.setMatrixAt(i, HIDDEN);
    this.beadMesh.count = shown;
    this.beadMesh.instanceMatrix.needsUpdate = true;
  }

  /** World position of a bead (follows the bone it hangs from). */
  private beadWorld(bead: Bead, out: Vector3): Vector3 {
    return out.copy(bead.pos).applyMatrix4(this.proxyMatrix(bead.surface, _m));
  }

  /** World gravity expressed in a surface's bind space. */
  private gravity(surface: SurfaceProxy, out: Vector3): Vector3 {
    this.proxyMatrix(surface, _m);
    _m.setPosition(0, 0, 0);
    return out.copy(DOWN).applyMatrix4(_m.invert()).normalize();
  }

  /** Bind space -> world for a surface proxy (its bone's skinning matrix). */
  private proxyMatrix(surface: SurfaceProxy, out: Matrix4): Matrix4 {
    return out.multiplyMatrices(surface.bone.matrixWorld, surface.boneInverse).multiply(surface.bindMatrix);
  }

  private faceNormal(surface: SurfaceProxy, face: number, out: Vector3): Vector3 {
    const geometry = surface.bvh.geometry;
    const pos = geometry.getAttribute('position');
    const index = geometry.index;
    const ia = index ? index.getX(face * 3) : face * 3;
    const ib = index ? index.getX(face * 3 + 1) : face * 3 + 1;
    const ic = index ? index.getX(face * 3 + 2) : face * 3 + 2;
    _a.fromBufferAttribute(pos, ia);
    _b.fromBufferAttribute(pos, ib).sub(_a);
    _c.fromBufferAttribute(pos, ic).sub(_a);
    return out.crossVectors(_b, _c).normalize();
  }
}
