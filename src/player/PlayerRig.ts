import { Group, type PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { WORLD } from '../config';

const UP = new Vector3(0, 1, 0);
const _q = new Quaternion();
const _forward = new Vector3();
const _head = new Vector3();

export const DESKTOP_FOV = 70;

/**
 * The player "dolly". In VR the XR reference space is this group's local
 * space: the camera, controllers and hands are its children, so moving or
 * rotating the rig recenters the player without touching tracking data.
 */
export class PlayerRig {
  readonly root = new Group();
  /** Extra rig height when the runtime only provides a 'local' (head-origin) space. */
  private floorOffset = 0;
  /** VR height calibration: raises/lowers the player to the opponent's eye level. */
  private heightOffset = 0;

  constructor(readonly camera: PerspectiveCamera) {
    this.root.name = 'player-rig';
    this.root.add(camera);
  }

  /** 0 for 'local-floor'; eye height for 'local' (whose origin is at the head). */
  setFloorOffset(offset: number): void {
    this.floorOffset = offset;
    this.root.position.y = offset + this.heightOffset;
  }

  setHeightOffset(offset: number): void {
    this.heightOffset = offset;
    this.root.position.y = this.floorOffset + offset;
    this.root.updateMatrixWorld(true);
  }

  /** VR: the tracked eye height above the floor, without the calibration offset. */
  trackedEyeHeight(): number {
    return this.camera.position.y + this.floorOffset;
  }

  /** Desktop mode: stand at the spawn point at a fixed eye height. */
  resetDesktop(): void {
    this.floorOffset = 0;
    this.root.position.set(WORLD.playerSpawnX, this.heightOffset, WORLD.playerSpawnZ);
    this.root.rotation.set(0, 0, 0);
    this.camera.position.set(0, WORLD.desktopEyeHeight, 0);
    // XR overwrites the camera FOV with the headset's; restore ours.
    this.camera.fov = DESKTOP_FOV;
    this.camera.updateProjectionMatrix();
  }

  /**
   * VR: move/rotate the rig so the tracked head ends up on the spawn point,
   * facing the opponent. Head pose is in reference-space (= rig-local) coords.
   */
  recenterXR(headPosition: DOMPointReadOnly, headOrientation: DOMPointReadOnly): void {
    _q.set(headOrientation.x, headOrientation.y, headOrientation.z, headOrientation.w);
    _forward.set(0, 0, -1).applyQuaternion(_q);
    const headYaw = Math.atan2(-_forward.x, -_forward.z);
    const rigYaw = WORLD.playerSpawnYaw - headYaw;

    _head.set(headPosition.x, 0, headPosition.z).applyAxisAngle(UP, rigYaw);
    this.root.rotation.set(0, rigYaw, 0);
    this.root.position.set(WORLD.playerSpawnX - _head.x, this.floorOffset + this.heightOffset, WORLD.playerSpawnZ - _head.z);
    this.root.updateMatrixWorld(true);
  }
}
