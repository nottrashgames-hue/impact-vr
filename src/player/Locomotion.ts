import { type PerspectiveCamera, Vector2, Vector3 } from 'three';
import { RING } from '../config';
import type { XRInput } from '../input/XRInput';
import type { PlayerRig } from './PlayerRig';

/** Walking speed at full stick deflection (m/s). */
const WALK_SPEED = 1.8;
const DEADZONE = 0.15;
const SNAP_ANGLE = Math.PI / 6;
/** Stick deflection that triggers a snap turn, and the one it must fall below to re-arm. */
const SNAP_TRIGGER = 0.7;
const SNAP_REARM = 0.35;
/** Smooth-turn rate at full deflection (rad/s). */
const TURN_RATE = 2.4;
/** The player's head stays this far inside the ropes. */
const ROPE_MARGIN = 0.3;

const UP = new Vector3(0, 1, 0);
const _stick = new Vector2();
const _forward = new Vector3();
const _right = new Vector3();
const _move = new Vector3();
const _head = new Vector3();
const _offset = new Vector3();

/**
 * VR thumbstick locomotion: left stick walks (head-relative, inside the
 * ropes), right stick snap- or smooth-turns about the head. Tracked hands
 * have no sticks, so this does nothing for them.
 */
export class Locomotion {
  private snapArmed = true;

  constructor(
    private readonly rig: PlayerRig,
    private readonly camera: PerspectiveCamera,
    private readonly input: XRInput,
  ) {}

  /** Returns true when the rig jumped (a snap turn), so hand velocities should be reset. */
  update(dt: number, smoothTurn: boolean): boolean {
    let teleported = false;
    const root = this.rig.root;

    // Walk: stick direction relative to where the head faces, on the floor plane.
    this.input.thumbstick('left', _stick);
    const amount = deadzone(_stick.length());
    if (amount > 0) {
      this.camera.getWorldDirection(_forward).setY(0);
      if (_forward.lengthSq() < 1e-6) _forward.set(0, 0, -1);
      _forward.normalize();
      _right.crossVectors(_forward, UP);
      _move
        .copy(_right)
        .multiplyScalar(_stick.x)
        .addScaledVector(_forward, -_stick.y)
        .setLength(amount * WALK_SPEED * dt);
      root.position.add(_move);
    }

    // Turn about the head, so the player pivots in place.
    this.input.thumbstick('right', _stick);
    let turn = 0;
    if (smoothTurn) {
      turn = -Math.sign(_stick.x) * deadzone(Math.abs(_stick.x)) * TURN_RATE * dt;
    } else if (this.snapArmed && Math.abs(_stick.x) > SNAP_TRIGGER) {
      turn = -Math.sign(_stick.x) * SNAP_ANGLE;
      this.snapArmed = false;
      teleported = true;
    } else if (Math.abs(_stick.x) < SNAP_REARM) {
      this.snapArmed = true;
    }
    if (turn !== 0) {
      this.camera.getWorldPosition(_head);
      _offset.subVectors(root.position, _head).applyAxisAngle(UP, turn);
      root.position.copy(_head).add(_offset);
      root.rotation.y += turn;
    }

    // Stay inside the ring: clamp the head, moving the rig by the correction.
    if (amount > 0 || turn !== 0) {
      root.updateMatrixWorld(true);
      this.camera.getWorldPosition(_head);
      const limit = RING.ropeHalfExtent - ROPE_MARGIN;
      root.position.x += clampDelta(_head.x, limit);
      root.position.z += clampDelta(_head.z, limit);
      root.updateMatrixWorld(true);
    }
    return teleported;
  }
}

/** 0 inside the deadzone, rescaled to 0..1 outside it. */
function deadzone(v: number): number {
  return v < DEADZONE ? 0 : Math.min(1, (v - DEADZONE) / (1 - DEADZONE));
}

/** Correction that brings `v` back into [-limit, limit]. */
function clampDelta(v: number, limit: number): number {
  return v > limit ? limit - v : v < -limit ? -limit - v : 0;
}
