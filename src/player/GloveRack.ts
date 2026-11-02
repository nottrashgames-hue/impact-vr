import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  type Scene,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WORLD } from '../config';
import type { Handedness } from '../input/XRInput';
import { GLOVE_COLOR_NAMES, GLOVE_COLORS, type GloveColor } from './GearProfile';
import { createGloveGeometry } from './GloveModel';
import type { PlayerHands } from './PlayerHands';

/** Grab radius (m) around a rack glove. */
const GRAB_RADIUS = 0.2;
const HIDDEN = new Matrix4().makeScale(0, 0, 0);

/**
 * Glove rack beside the player (Section 4): a stand with a pair of gloves in
 * each colour hanging by the cuffs. Grab one (controller grip or a pinch) to
 * put it on that hand; grab at an empty peg with a gloved hand to hang it back.
 */
export class GloveRack {
  readonly root = new Group();
  private readonly instances: Record<Handedness, InstancedMesh>;
  /** Peg positions (world), per colour and side. */
  private readonly pegs = new Map<string, Vector3>();

  constructor(scene: Scene) {
    this.root.name = 'glove-rack';
    // To the player's right, within arm's reach of the spawn point.
    const base = new Vector3(WORLD.playerSpawnX + 0.62, 0, WORLD.playerSpawnZ - 0.05);

    const metal = new MeshStandardMaterial({ color: 0x2c3036, metalness: 0.7, roughness: 0.35 });
    const stand = mergeGeometries(
      [
        new CylinderGeometry(0.018, 0.018, 1.32, 12).translate(0, 0.66, -0.3),
        new CylinderGeometry(0.018, 0.018, 1.32, 12).translate(0, 0.66, 0.3),
        new BoxGeometry(0.04, 0.03, 0.66).translate(0, 1.3, 0),
        new BoxGeometry(0.34, 0.02, 0.1).translate(0, 0.01, -0.3),
        new BoxGeometry(0.34, 0.02, 0.1).translate(0, 0.01, 0.3),
      ].map((g) => g.toNonIndexed()),
    );
    if (!stand) throw new Error('GloveRack: merge failed');
    const standMesh = new Mesh(stand, metal);
    standMesh.position.copy(base);
    this.root.add(standMesh);

    const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.38 });
    this.instances = {
      left: new InstancedMesh(createGloveGeometry('left', 12), material, GLOVE_COLOR_NAMES.length),
      right: new InstancedMesh(createGloveGeometry('right', 12), material, GLOVE_COLOR_NAMES.length),
    };
    const color = new Color();
    const m = new Matrix4();
    // Hanging from the bar: grip +Y (towards the forearm) points up, so the mitt hangs down.
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2);
    GLOVE_COLOR_NAMES.forEach((name, i) => {
      for (const side of ['left', 'right'] as const) {
        const z = -0.24 + i * 0.16 + (side === 'left' ? -0.035 : 0.035);
        const p = new Vector3(base.x, 1.12, base.z + z);
        m.compose(p, q, new Vector3(1, 1, 1));
        this.instances[side].setMatrixAt(i, m);
        this.instances[side].setColorAt(i, color.setHex(GLOVE_COLORS[name]));
        this.pegs.set(`${name}:${side}`, p);
      }
    });
    for (const mesh of Object.values(this.instances)) {
      mesh.castShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      this.root.add(mesh);
    }
    scene.add(this.root);
  }

  /** Shows only the gloves that aren't being worn. */
  sync(hands: PlayerHands): void {
    const m = new Matrix4();
    const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2);
    GLOVE_COLOR_NAMES.forEach((name, i) => {
      for (const side of ['left', 'right'] as const) {
        const worn = hands.get(side).gloveColor === name;
        const peg = this.pegs.get(`${name}:${side}`) as Vector3;
        this.instances[side].setMatrixAt(i, worn ? HIDDEN : m.compose(peg, q, new Vector3(1, 1, 1)));
      }
    });
    for (const mesh of Object.values(this.instances)) mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * A grab with one hand near the rack. Returns the glove colour to put on,
   * 'remove' to hang the worn glove back up, or null if nothing is in reach.
   */
  grab(side: Handedness, handPoint: Vector3, wornColor: GloveColor | null): GloveColor | 'remove' | null {
    let best: GloveColor | null = null;
    let bestDistance = GRAB_RADIUS;
    for (const name of GLOVE_COLOR_NAMES) {
      const peg = this.pegs.get(`${name}:${side}`) as Vector3;
      const d = peg.distanceTo(handPoint);
      if (d < bestDistance) {
        bestDistance = d;
        best = name;
      }
    }
    if (!best) return null;
    if (wornColor) return 'remove';
    return best;
  }
}
