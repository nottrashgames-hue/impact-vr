import { Vector2, Vector3 } from 'three';
import { WORLD } from '../config';
import type { PlayerRig } from '../player/PlayerRig';

const LOOK_SENSITIVITY = 0.0035; // radians per pixel
const MOVE_SPEED = 1.6; // m/s
const MAX_PITCH = 1.35;
/** Pointer travel (px) before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;

const _forward = new Vector3();
const _right = new Vector3();

/**
 * Non-VR fallback controls: drag to look, WASD / arrows to move inside the ring.
 * A press without dragging is reserved for desktop punching (Milestone 3).
 */
export class DesktopControls {
  enabled = true;
  /** Pointer position in normalised device coordinates (-1..1), for picking. */
  readonly pointer = new Vector2();
  /** Whether the pointer is over the canvas. */
  pointerInside = false;
  private yaw: number = WORLD.playerSpawnYaw;
  private pitch = -0.12;
  private readonly keys = new Set<string>();
  private dragPointer: number | null = null;
  private dragDistance = 0;
  private readonly clickListeners: Array<() => void> = [];
  private lastX = 0;
  private lastY = 0;

  constructor(
    private readonly element: HTMLElement,
    private readonly rig: PlayerRig,
  ) {
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerUp);
    element.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  /** A primary-button press released without dragging (desktop punch); see {@link pointer}. */
  onClick(listener: () => void): void {
    this.clickListeners.push(listener);
  }

  /** Back to the spawn point, looking at the opponent. */
  reset(): void {
    this.yaw = WORLD.playerSpawnYaw;
    this.pitch = -0.12;
    this.rig.resetDesktop();
    this.applyLook();
  }

  update(dt: number): void {
    if (!this.enabled) return;
    let forward = 0;
    let strafe = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) forward += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) forward -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) strafe += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) strafe -= 1;

    if (forward !== 0 || strafe !== 0) {
      _forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const len = Math.hypot(forward, strafe);
      const step = (MOVE_SPEED * dt) / len;
      const p = this.rig.root.position;
      p.addScaledVector(_forward, forward * step).addScaledVector(_right, strafe * step);
      const limit = WORLD.desktopMoveLimit;
      p.x = Math.min(limit, Math.max(-limit, p.x));
      p.z = Math.min(limit, Math.max(-limit, p.z));
    }
    this.applyLook();
  }

  dispose(): void {
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    this.element.removeEventListener('pointermove', this.onPointerMove);
    this.element.removeEventListener('pointerup', this.onPointerUp);
    this.element.removeEventListener('pointercancel', this.onPointerUp);
    this.element.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  private applyLook(): void {
    this.rig.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled || this.dragPointer !== null) return;
    this.dragPointer = event.pointerId;
    this.dragDistance = 0;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.element.setPointerCapture(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const rect = this.element.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.pointerInside = true;
    if (event.pointerId !== this.dragPointer) return;
    const dx = event.clientX - this.lastX;
    const dy = event.clientY - this.lastY;
    this.lastX = event.clientX;
    this.lastY = event.clientY;
    this.dragDistance += Math.abs(dx) + Math.abs(dy);
    if (this.dragDistance < DRAG_THRESHOLD) return;
    this.yaw -= dx * LOOK_SENSITIVITY;
    this.pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, this.pitch - dy * LOOK_SENSITIVITY));
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.dragPointer) return;
    this.element.releasePointerCapture(event.pointerId);
    this.dragPointer = null;
    if (event.type === 'pointerup' && event.button === 0 && this.dragDistance < DRAG_THRESHOLD && this.enabled) {
      for (const listener of this.clickListeners) listener();
    }
  };

  private readonly onPointerLeave = (): void => {
    this.pointerInside = false;
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
  };
}
