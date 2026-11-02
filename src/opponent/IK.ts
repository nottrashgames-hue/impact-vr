import { type Object3D, Quaternion, Vector3 } from 'three';

/**
 * Rig-agnostic posing helpers. They work purely from bone positions and
 * world-space directions, so the same animation code drives the procedural
 * rig and any GLB regardless of its bone axis conventions.
 */

const _wq = new Quaternion();
const _pq = new Quaternion();
const _delta = new Quaternion();
const _tmp = new Quaternion();
const _from = new Vector3();
const _to = new Vector3();

/** Sets a bone's world-space orientation (keeps its position). */
export function setWorldQuaternion(bone: Object3D, worldQuat: Quaternion): void {
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_pq).invert();
    bone.quaternion.copy(_pq).multiply(worldQuat);
  } else {
    bone.quaternion.copy(worldQuat);
  }
  bone.updateMatrixWorld(true);
}

/** Applies an extra world-space rotation on top of a bone's current orientation. */
export function rotateWorld(bone: Object3D, worldRotation: Quaternion): void {
  bone.getWorldQuaternion(_wq);
  _tmp.copy(worldRotation).multiply(_wq);
  setWorldQuaternion(bone, _tmp);
}

/**
 * Rotates a bone (shortest arc, in world space) so that `localAxis` points
 * along `worldDir`. `weight` < 1 only rotates part of the way.
 */
export function aimBone(bone: Object3D, localAxis: Vector3, worldDir: Vector3, weight = 1): void {
  bone.getWorldQuaternion(_wq);
  _from.copy(localAxis).applyQuaternion(_wq).normalize();
  _to.copy(worldDir).normalize();
  _delta.setFromUnitVectors(_from, _to);
  if (weight < 1) _delta.copy(_tmp.identity().slerp(_delta, weight));
  _tmp.copy(_delta).multiply(_wq);
  setWorldQuaternion(bone, _tmp);
}

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _n = new Vector3();
const _p = new Vector3();
const _joint = new Vector3();
const _goal = new Vector3();
const _dir = new Vector3();

/**
 * Analytic two-bone IK (shoulder–elbow–wrist, hip–knee–ankle).
 * @param upperAxis local direction from `upper` to `lower` (i.e. `lower.position` normalised)
 * @param lowerAxis local direction from `lower` to `end`
 * @param pole      world direction the middle joint should bend towards
 */
export function solveTwoBone(
  upper: Object3D,
  lower: Object3D,
  end: Object3D,
  target: Vector3,
  pole: Vector3,
  upperAxis: Vector3,
  lowerAxis: Vector3,
): void {
  upper.getWorldPosition(_a);
  lower.getWorldPosition(_b);
  end.getWorldPosition(_c);
  const l1 = _a.distanceTo(_b);
  const l2 = _b.distanceTo(_c);

  _dir.subVectors(target, _a);
  const reach = _dir.length();
  const d = Math.min(Math.max(reach, Math.abs(l1 - l2) + 1e-4), (l1 + l2) * 0.999);
  _n.copy(_dir).divideScalar(Math.max(reach, 1e-6));

  const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _p.copy(pole).addScaledVector(_n, -pole.dot(_n));
  if (_p.lengthSq() < 1e-8) _p.set(0, 0, 1).addScaledVector(_n, -_n.z);
  _p.normalize();

  _joint.copy(_a).addScaledVector(_n, l1 * cosA).addScaledVector(_p, l1 * sinA);
  aimBone(upper, upperAxis, _dir.subVectors(_joint, _a));

  _goal.copy(_a).addScaledVector(_n, d);
  lower.getWorldPosition(_b);
  aimBone(lower, lowerAxis, _dir.subVectors(_goal, _b));
}
