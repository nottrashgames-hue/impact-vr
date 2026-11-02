import RAPIER from '@dimforge/rapier3d-compat';
import { type Bone, Euler, Matrix4, Quaternion, Raycaster, type Scene, Vector2, Vector3 } from 'three';
import { KNOCKOUT, WORLD } from '../config';
import { COLLISION_GROUP, interactionGroups, type Physics } from '../core/Physics';
import type { QualityPreset } from '../core/Quality';
import type { Impact } from '../damage/Impact';
import type { ZoneId } from '../damage/Zones';
import { loadGLBHumanoid } from './GLBHumanoid';
import { Hitboxes } from './Hitboxes';
import { HitReactions } from './HitReactions';
import { type CanonicalBone, type HumanoidRig, RestPose } from './HumanoidRig';
import { IdleAnimator } from './IdleAnimator';
import { OPPONENT_CONFIG } from './OpponentConfig';
import { LID_CLOSE_DELTA } from './procedural/BodyLayout';
import { createProceduralHumanoid } from './procedural/ProceduralHumanoid';
import { Ragdoll } from './Ragdoll';

export interface OpponentHit {
  /** Final zone: a face region for head hits, otherwise the hitbox's zone. */
  readonly zone: ZoneId;
  /** Name of the collider that was hit (e.g. "skull", "Left forearm"). */
  readonly hitbox: string;
  /** Bone the collider belongs to. */
  readonly bone: CanonicalBone;
  readonly point: Vector3;
  readonly normal: Vector3;
  /** Mesh UV of the hit for head hits (used for face lookup and, later, painting). */
  readonly uv: Vector2 | null;
}

export type OpponentState = 'standing' | 'knockedOut' | 'gettingUp';

/**
 * Loads the opponent rig: the configured GLB if there is one, otherwise (or if
 * it fails to load) the procedural humanoid.
 */
export async function loadOpponentRig(quality: QualityPreset): Promise<HumanoidRig> {
  const url = OPPONENT_CONFIG.modelUrl;
  if (url) {
    try {
      return await loadGLBHumanoid(OPPONENT_CONFIG, url);
    } catch (err) {
      console.warn(`[IMPACT] Could not load opponent model "${url}", using the procedural opponent.`, err);
    }
  }
  return createProceduralHumanoid(quality.level === 'pc' ? 2048 : 1024);
}

/** Knockout blow: N·s of impulse per m/s of punch speed, on the struck body and on the chest. */
const KNOCKOUT_IMPULSE = 1.6;
const KNOCKOUT_CHEST_IMPULSE = 0.8;
/** Shove on an already-downed body. */
const DOWNED_IMPULSE = 1.2;

const _origin = new Vector3();
const _dir = new Vector3();
const _inv = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();

interface PoseSnapshot {
  readonly bone: Bone;
  readonly position: Vector3;
  readonly quaternion: Quaternion;
}

/** The training opponent: rig + idle animation + hit reactions + physics hitboxes + knockout ragdoll. */
export class Opponent {
  readonly hitboxes: Hitboxes;
  readonly reactions: HitReactions;
  /** Exposed for the AI (OpponentBrain) hooks: guard raise, hand overrides, lean. */
  readonly animator: IdleAnimator;
  private readonly ragdoll: Ragdoll;
  private readonly rest: RestPose;
  private readonly raycaster = new Raycaster();
  private readonly allBones: Bone[] = [];
  private debugView = false;
  /** After a knockout: wait for a reset ('prompt') or stand back up ('getUp'). */
  koRecovery: 'prompt' | 'getUp' = KNOCKOUT.recovery;
  /** Size of one bind-space unit of the paint surfaces, in metres. */
  readonly metersPerBindUnit: number;
  private _state: OpponentState = 'standing';
  /** Seconds spent in the current state. */
  private stateTime = 0;
  private getUpFrom: PoseSnapshot[] = [];

  constructor(
    scene: Scene,
    private readonly physics: Physics,
    readonly rig: HumanoidRig,
  ) {
    // Capture the rest pose while the root is still at the origin (character space).
    this.rest = new RestPose(rig);
    rig.root.position.set(WORLD.opponentX, 0, WORLD.opponentZ);
    rig.root.rotation.set(0, 0, 0); // faces +Z, towards the player
    scene.add(rig.root);
    rig.root.traverse((o) => {
      if ((o as Bone).isBone) this.allBones.push(o as Bone);
    });

    this.reactions = new HitReactions(rig);
    this.animator = new IdleAnimator(rig, this.rest, this.reactions);
    this.animator.update(0, new Vector3(WORLD.playerSpawnX, 1.6, WORLD.playerSpawnZ));
    this.hitboxes = new Hitboxes(physics, rig, this.rest);
    scene.add(this.hitboxes.debugGroup);
    this.ragdoll = new Ragdoll(physics, rig, this.hitboxes, this.rest);
    this.metersPerBindUnit = this.skinMatrix('Hips', _inv).getMaxScaleOnAxis();
  }

  /** World -> bind space of the paint surfaces, using `bone`'s skinning matrix. */
  toBind(world: Vector3, bone: CanonicalBone, out: Vector3): Vector3 {
    return out.copy(world).applyMatrix4(this.skinMatrix(bone, _inv).invert());
  }

  /** A point in character rest space (e.g. relative to the skull centre) -> bind space, via `bone`. */
  characterRestToBind(point: Vector3, bone: CanonicalBone): Vector3 {
    const b = this.rig.bones[bone] ?? this.rig.bones.Head;
    const world = point.clone().applyMatrix4(_inv.copy(this.rest.characterMatrix(b)).invert()).applyMatrix4(b.matrixWorld);
    return this.toBind(world, bone, world);
  }

  /** Bind space -> world, using `bone`'s skinning matrix. */
  fromBind(bind: Vector3, bone: CanonicalBone, out: Vector3): Vector3 {
    return out.copy(bind).applyMatrix4(this.skinMatrix(bone, _inv));
  }

  /** Eyeball centre in bind space (for black-eye rings), or null if it can't be estimated. */
  eyeBindPosition(side: 'Left' | 'Right', out: Vector3): Vector3 | null {
    const eye = this.rig.bones[`${side}Eye`];
    if (eye) return this.toBind(eye.getWorldPosition(_origin), 'Head', out);
    // No eye bones: estimate from the skull centre (character rest space) through the head bone.
    const s = this.rig.height / 1.8;
    const head = this.rig.bones.Head;
    _origin.copy(this.rig.headCenter).add(new Vector3((side === 'Left' ? 0.034 : -0.034) * s, 0, 0.075 * s));
    _origin.applyMatrix4(_inv.copy(this.rest.characterMatrix(head)).invert()).applyMatrix4(head.matrixWorld);
    return this.toBind(_origin, 'Head', out);
  }

  /** Swelling closure per eye (0 open .. ~1 swollen shut), applied by the animator. */
  setEyeClosure(left: number, right: number): void {
    this.animator.eyeClosure.Left = left;
    this.animator.eyeClosure.Right = right;
  }

  /** The skinning matrix (bind space -> world) of a bone of the paint reference mesh. */
  private skinMatrix(boneName: CanonicalBone, out: Matrix4): Matrix4 {
    const ref = this.rig.paintReference;
    const bone = this.rig.bones[boneName] ?? this.rig.bones.Hips;
    let index = ref.skeleton.bones.indexOf(bone);
    if (index < 0) index = Math.max(0, ref.skeleton.bones.indexOf(this.rig.bones.Hips));
    return out.multiplyMatrices(ref.skeleton.bones[index].matrixWorld, ref.skeleton.boneInverses[index]).multiply(ref.bindMatrix);
  }

  get state(): OpponentState {
    return this._state;
  }

  /** Seconds since the opponent entered its current state. */
  get timeInState(): number {
    return this.stateTime;
  }

  get debugVisible(): boolean {
    return this.debugView;
  }

  /** Zone colours on the body + hitbox wireframes. */
  setDebugView(enabled: boolean): void {
    this.debugView = enabled;
    this.rig.setZoneDebugView(enabled);
    this.hitboxes.setDebugVisible(enabled);
    this.hitboxes.syncDebug();
  }

  /** Back to a clean, standing idle state (damage and blood reset is handled by their systems). */
  reset(): void {
    this.ragdoll.deactivate();
    this.reactions.reset();
    this.animator.reset();
    this.setState('standing');
    this.rig.root.updateMatrixWorld(true);
    this.hitboxes.sync(true);
  }

  /** Reacts to a registered hit; `knockout` drops the opponent into a full ragdoll. */
  hit(impact: Impact, knockout: boolean): void {
    if (this._state === 'knockedOut') {
      _dir.copy(impact.direction).multiplyScalar(impact.speed * DOWNED_IMPULSE);
      this.ragdoll.applyImpulse(impact.bone, impact.point, _dir);
      return;
    }
    if (knockout) {
      this.knockOut(impact);
      return;
    }
    this.reactions.applyImpact(impact);
  }

  /**
   * A glove pressing on him (no punch): bends and shoves the standing body
   * (Section 4). While knocked out, the fist bodies push the ragdoll physically.
   */
  push(collider: RAPIER.Collider, point: Vector3, force: Vector3, dt: number): void {
    if (this._state !== 'standing') return;
    const info = this.hitboxes.lookup(collider);
    if (info) this.reactions.push(info.bone, point, force, dt);
  }

  private knockOut(impact: Impact): void {
    // The struck part snaps away; a push on the chest carries the body over as the legs give.
    this.ragdoll.activate(impact.bone, impact.point, _dir.copy(impact.direction).multiplyScalar(impact.speed * KNOCKOUT_IMPULSE));
    const chest = this.rig.bones.Spine2.getWorldPosition(_origin);
    this.ragdoll.applyImpulse('Spine2', chest, _dir.copy(impact.direction).setY(0).multiplyScalar(impact.speed * KNOCKOUT_CHEST_IMPULSE));
    this.reactions.reset();
    this.setState('knockedOut');
  }

  /** Begins the automatic get-up (blend from the ragdoll pose back to the guard). */
  getUp(): void {
    if (this._state !== 'knockedOut') return;
    this.getUpFrom = this.allBones.map((bone) => ({
      bone,
      position: bone.position.clone(),
      quaternion: bone.quaternion.clone(),
    }));
    this.ragdoll.deactivate();
    this.reactions.reset();
    this.animator.reset();
    this.setState('gettingUp');
  }

  /** Fixed-step work before the physics step. */
  fixedUpdate(dt: number): void {
    this.reactions.step(dt);
    this.ragdoll.beforeStep(dt);
  }

  afterPhysicsStep(): void {
    this.ragdoll.afterStep();
  }

  /**
   * @param dt      frame delta (seconds)
   * @param time    seconds since start
   * @param lookAt  the player's head position (world)
   * @param alpha   interpolation factor between the last two physics steps
   * @param fatigue 0..1 from the damage model
   */
  update(dt: number, time: number, lookAt: Vector3, alpha: number, fatigue: number): void {
    this.stateTime += dt;
    switch (this._state) {
      case 'standing':
        this.animator.update(time, lookAt, fatigue);
        this.hitboxes.sync();
        break;
      case 'knockedOut':
        this.ragdoll.syncBones(alpha);
        this.poseKnockedOutFace();
        this.hitboxes.syncDebug();
        if (this.koRecovery === 'getUp' && this.stateTime > KNOCKOUT.getUpDelay) this.getUp();
        break;
      case 'gettingUp': {
        this.animator.update(time, lookAt, fatigue);
        const t = Math.min(1, this.stateTime / KNOCKOUT.getUpDuration);
        const e = t * t * (3 - 2 * t);
        // Blend from the pose the body landed in to the freshly animated guard.
        for (const snap of this.getUpFrom) {
          snap.bone.position.lerpVectors(snap.position, snap.bone.position, e);
          _q.copy(snap.bone.quaternion);
          snap.bone.quaternion.slerpQuaternions(snap.quaternion, _q, e);
        }
        this.rig.root.updateMatrixWorld(true);
        this.hitboxes.sync(this.stateTime <= dt);
        if (t >= 1) this.setState('standing');
        break;
      }
    }
  }

  /** Eyes mostly shut and jaw slack while out cold. */
  private poseKnockedOutFace(): void {
    const b = this.rig.bones;
    for (const lid of [b.LeftUpperLid, b.RightUpperLid]) {
      if (!lid) continue;
      lid.quaternion.copy(this.rest.restLocalQuaternion(lid)).multiply(_q.setFromEuler(_e.set(0.85 * LID_CLOSE_DELTA, 0, 0)));
      lid.updateMatrixWorld(true);
    }
    if (b.Jaw) {
      b.Jaw.quaternion.copy(this.rest.restLocalQuaternion(b.Jaw)).multiply(_q.setFromEuler(_e.set(0.14, 0, 0)));
      b.Jaw.updateMatrixWorld(true);
    }
    for (const morph of this.rig.blinkMorphs) {
      const influences = morph.mesh.morphTargetInfluences;
      if (!influences) continue;
      influences[morph.left] = 0.85;
      influences[morph.right] = 0.85;
    }
  }

  private setState(state: OpponentState): void {
    this._state = state;
    this.stateTime = 0;
  }

  /**
   * Resolves a contact on one of the opponent's colliders to a zone. Head,
   * face and neck contacts are refined by raycasting the head mesh along the
   * strike direction and looking up the face region at the hit UV (Section 5).
   */
  describeContact(collider: RAPIER.Collider, point: Vector3, normal: Vector3, direction: Vector3): OpponentHit | null {
    const info = this.hitboxes.lookup(collider);
    if (!info) return null;
    const base: OpponentHit = { zone: info.zone, hitbox: info.name, bone: info.bone, point: point.clone(), normal: normal.clone(), uv: null };
    if (!info.isHead) return base;
    // Start a little in front of the contact so the ray meets the skin surface.
    _origin.copy(point).addScaledVector(direction, -0.12);
    return this.refineHeadHit(base, _origin, direction, 0.3) ?? base;
  }

  /**
   * Casts a ray against the opponent's hitboxes (debug probe, desktop
   * targeting); head hits are refined to a face region like punches.
   */
  raycast(origin: Vector3, direction: Vector3, maxDistance = 5): OpponentHit | null {
    _dir.copy(direction).normalize();
    const ray = new RAPIER.Ray(origin, _dir);
    const groups = interactionGroups(0xffff, COLLISION_GROUP.OPPONENT);
    const hit = this.physics.world.castRayAndGetNormal(ray, maxDistance, true, undefined, groups);
    if (!hit) return null;
    const info = this.hitboxes.lookup(hit.collider);
    if (!info) return null;
    const point = origin.clone().addScaledVector(_dir, hit.timeOfImpact);
    const base: OpponentHit = {
      zone: info.zone,
      hitbox: info.name,
      bone: info.bone,
      point,
      normal: new Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
      uv: null,
    };
    if (!info.isHead) return base;
    return this.refineHeadHit(base, origin, _dir, maxDistance) ?? base;
  }

  private refineHeadHit(base: OpponentHit, origin: Vector3, direction: Vector3, far: number): OpponentHit | null {
    this.raycaster.set(origin, direction);
    this.raycaster.far = far;
    let best: { point: Vector3; uv: Vector2 | null; normal: Vector3 | null; distance: number } | null = null;
    for (const proxy of this.rig.headProxies) {
      proxy.mesh.matrixWorld.multiplyMatrices(proxy.bone.matrixWorld, proxy.boneInverse).multiply(proxy.bindMatrix);
      const h = this.raycaster.intersectObject(proxy.mesh, false)[0];
      if (h && (!best || h.distance < best.distance)) {
        best = {
          point: h.point,
          uv: h.uv ?? null,
          normal: h.face ? h.face.normal.clone().transformDirection(proxy.mesh.matrixWorld) : null,
          distance: h.distance,
        };
      }
    }
    // Missed the head mesh: a genuine neck hit, or a graze of the skull capsule.
    if (!best) return null;

    // Bind-pose position of the hit, for rigs that classify geometrically.
    const head = this.rig.bones.Head;
    const restPoint = best.point.clone().applyMatrix4(_inv.copy(head.matrixWorld).invert()).applyMatrix4(this.rest.characterMatrix(head));
    const zone = this.rig.faceRegions.classify({ uv: best.uv, restPoint });
    return { ...base, zone, point: best.point, normal: best.normal ?? base.normal, uv: best.uv };
  }
}
