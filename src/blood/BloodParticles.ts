import RAPIER from '@dimforge/rapier3d-compat';
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
} from 'three';
import { RING } from '../config';
import { COLLISION_GROUP, interactionGroups, type Physics } from '../core/Physics';
import { debugStats } from '../debug/DebugStats';

const GRAVITY = -9.81;
/** Air drag on small droplets (1/s). */
const DRAG = 0.6;
const MAX_LIFE = 6;
const ABSOLUTE_MAX = 1500;

/** What a droplet can hit. Handlers return true if the droplet should die. */
export interface DropletHandlers {
  floor(x: number, z: number, velocity: Vector3, radius: number): void;
  /**
   * The step from `origin` along `velocity` (length `step` m) touches an
   * opponent hitbox; the handler decides (e.g. by raycasting the real skin)
   * whether the droplet actually lands. Returns true if it does.
   */
  opponent(collider: RAPIER.Collider, origin: Vector3, velocity: Vector3, step: number, radius: number): boolean;
  /** Point-vs-sphere test against the player's fists/gloves; return true if absorbed. */
  player(point: Vector3, radius: number): boolean;
  /** Near the player's eyes; return true if absorbed (visor splatter). */
  visor(point: Vector3, velocity: Vector3): boolean;
}

const _p = new Vector3();
const _v = new Vector3();
const _dir = new Vector3();
const _q = new Quaternion();
const _m = new Matrix4();
const _s = new Vector3();
const UP = new Vector3(0, 1, 0);
const HIDDEN = new Matrix4().makeScale(0, 0, 0);

/**
 * Blood droplets (Section 7.1): one InstancedMesh, hard capped per quality
 * preset with oldest-first recycling. Each droplet integrates gravity and air
 * drag; collisions are cheap analytic tests (floor plane, fist spheres, visor)
 * plus a Rapier raycast against the opponent's hitboxes only when nearby.
 * Droplets are stretched along their velocity so falling drops read as streaks.
 */
export class BloodParticles {
  readonly mesh: InstancedMesh;
  private readonly material: MeshStandardMaterial;
  private readonly pos = new Float32Array(ABSOLUTE_MAX * 3);
  private readonly vel = new Float32Array(ABSOLUTE_MAX * 3);
  private readonly rad = new Float32Array(ABSOLUTE_MAX);
  private readonly life = new Float32Array(ABSOLUTE_MAX);
  private count = 0;
  private capacity: number;
  /** Ring index of the oldest droplet once the pool is full. */
  private oldest = 0;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private readonly groups = interactionGroups(0xffff, COLLISION_GROUP.OPPONENT);

  constructor(
    scene: Scene,
    private readonly physics: Physics,
    capacity: number,
    /** Opponent's position (x/z), to skip raycasts for droplets far away. */
    private readonly opponentCenter: Vector3,
  ) {
    this.capacity = Math.min(capacity, ABSOLUTE_MAX);
    this.material = new MeshStandardMaterial({ name: 'blood-droplet', roughness: 0.12, metalness: 0 });
    this.mesh = new InstancedMesh(new SphereGeometry(1, 8, 6), this.material, ABSOLUTE_MAX);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'blood-droplets';
    scene.add(this.mesh);
  }

  get active(): number {
    return this.count;
  }

  setCapacity(capacity: number): void {
    this.capacity = Math.min(capacity, ABSOLUTE_MAX);
    if (this.count > this.capacity) this.count = this.capacity;
  }

  setColor(color: Color): void {
    // Fresh blood is a little brighter than the painted, drying stains.
    this.material.color.copy(color).multiplyScalar(1.6);
  }

  spawn(position: Vector3, velocity: Vector3, radius: number): void {
    if (this.capacity <= 0) return;
    let i: number;
    if (this.count < this.capacity) {
      i = this.count++;
    } else {
      // Full: recycle the oldest.
      i = this.oldest;
      this.oldest = (this.oldest + 1) % this.capacity;
    }
    this.pos.set([position.x, position.y, position.z], i * 3);
    this.vel.set([velocity.x, velocity.y, velocity.z], i * 3);
    this.rad[i] = radius;
    this.life[i] = 0;
  }

  clear(): void {
    this.count = 0;
    this.oldest = 0;
    this.mesh.count = 0;
  }

  update(dt: number, handlers: DropletHandlers): void {
    const floorHalf = RING.floorSize / 2;
    const drag = Math.exp(-DRAG * dt);
    let i = 0;
    while (i < this.count) {
      const k = i * 3;
      _p.set(this.pos[k], this.pos[k + 1], this.pos[k + 2]);
      _v.set(this.vel[k] * drag, this.vel[k + 1] * drag + GRAVITY * dt, this.vel[k + 2] * drag);
      const r = this.rad[i];
      this.life[i] += dt;
      let dead = this.life[i] > MAX_LIFE;

      // Opponent: raycast along this step's motion (only near him).
      if (!dead && Math.hypot(_p.x - this.opponentCenter.x, _p.z - this.opponentCenter.z) < 1.2 && _p.y > 0 && _p.y < 2.1) {
        const step = _v.length() * dt + r;
        _dir.copy(_v).normalize();
        this.ray.origin = _p;
        this.ray.dir = _dir;
        const hit = this.physics.world.castRay(this.ray, step, true, undefined, this.groups);
        if (hit) dead = handlers.opponent(hit.collider, _p, _v, step, r);
      }

      _p.addScaledVector(_v, dt);
      if (!dead) dead = handlers.player(_p, r) || handlers.visor(_p, _v);
      if (!dead && _p.y - r <= 0 && Math.abs(_p.x) < floorHalf && Math.abs(_p.z) < floorHalf) {
        handlers.floor(_p.x, _p.z, _v, r);
        dead = true;
      }
      if (!dead && _p.y < -1) dead = true; // fell off the ring onto the gym floor

      if (dead) {
        this.removeAt(i);
        continue;
      }
      this.pos.set([_p.x, _p.y, _p.z], k);
      this.vel.set([_v.x, _v.y, _v.z], k);
      i++;
    }
    this.writeMatrices();
    debugStats.particles = this.count;
  }

  /** Swap-remove (order doesn't matter for rendering). */
  private removeAt(i: number): void {
    const last = --this.count;
    if (i !== last) {
      this.pos.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.vel.copyWithin(i * 3, last * 3, last * 3 + 3);
      this.rad[i] = this.rad[last];
      this.life[i] = this.life[last];
    }
    if (this.oldest >= this.count) this.oldest = 0;
  }

  private writeMatrices(): void {
    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      _p.set(this.pos[k], this.pos[k + 1], this.pos[k + 2]);
      _v.set(this.vel[k], this.vel[k + 1], this.vel[k + 2]);
      const speed = _v.length();
      const r = this.rad[i];
      // Stretch along the velocity: a falling drop reads as a short streak.
      if (speed > 1e-4) _q.setFromUnitVectors(UP, _v.divideScalar(speed));
      else _q.identity();
      _m.compose(_p, _q, _s.set(r, r * (1 + speed * 0.09), r));
      this.mesh.setMatrixAt(i, _m);
    }
    for (let i = this.count; i < this.mesh.count; i++) this.mesh.setMatrixAt(i, HIDDEN);
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
