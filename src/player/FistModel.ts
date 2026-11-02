import {
  type BufferGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Handedness } from '../input/XRInput';

/**
 * Procedural bare-fist model, authored directly in WebXR grip space so it can
 * be driven by `renderer.xr.getControllerGrip()` with no extra offsets.
 *
 * Grip space (WebXR spec): origin at the centre of the curled fingers, -Z
 * along the held "rod" towards the thumb, +X out of the back of the right hand
 * (-X for the left), +Y back along the forearm — so the punching face of the
 * fist points along -Y.
 *
 * The fist is modelled in a friendlier "fist frame" (punch direction -Z, back
 * of the hand +Y, knuckle row along X, wrist towards +Z) and then rotated into
 * grip space.
 */

export const PLAYER_SKIN_COLOR = 0xc89274;

export function createPlayerSkinMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    name: 'player-skin',
    color: PLAYER_SKIN_COLOR,
    roughness: 0.62,
    metalness: 0,
  });
}

/** Where the grip origin sits inside the fist, in fist-frame coordinates. */
const GRIP_ORIGIN_IN_FIST = new Vector3(0, -0.015, 0);
/**
 * Centre of the strike sphere, in fist-frame coordinates: set back from the
 * knuckles so a sphere of `PUNCH.fistRadius` just covers the striking face.
 */
const STRIKE_CENTER_IN_FIST = new Vector3(0, -0.006, -0.006);

/** Fist frame -> grip space, per hand (see module comment). Shared with the glove model. */
export function fistToGripMatrix(side: Handedness): Matrix4 {
  const m = new Matrix4();
  if (side === 'right') {
    m.makeBasis(new Vector3(0, 0, 1), new Vector3(1, 0, 0), new Vector3(0, 1, 0));
  } else {
    m.makeBasis(new Vector3(0, 0, -1), new Vector3(-1, 0, 0), new Vector3(0, 1, 0));
  }
  m.multiply(new Matrix4().makeTranslation(-GRIP_ORIGIN_IN_FIST.x, -GRIP_ORIGIN_IN_FIST.y, -GRIP_ORIGIN_IN_FIST.z));
  return m;
}

/** Strike-sphere centre in grip space (used for punch detection and velocity). */
export function strikeCenterInGrip(side: Handedness): Vector3 {
  return STRIKE_CENTER_IN_FIST.clone().applyMatrix4(fistToGripMatrix(side));
}

const _yAxis = new Vector3(0, 1, 0);

/** A capsule spanning two points. */
function capsuleBetween(a: Vector3, b: Vector3, radius: number): BufferGeometry {
  const dir = new Vector3().subVectors(b, a);
  const length = dir.length();
  const geo = new CapsuleGeometry(radius, Math.max(0.001, length), 4, 10);
  geo.applyQuaternion(new Quaternion().setFromUnitVectors(_yAxis, dir.normalize()));
  geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return geo;
}

function nonIndexed(geo: BufferGeometry): BufferGeometry {
  if (!geo.index) return geo;
  const out = geo.toNonIndexed();
  geo.dispose();
  return out;
}

/** Builds the merged fist geometry (one draw call) in grip space. */
export function createFistGeometry(side: Handedness): BufferGeometry {
  // Mirror X for the left hand: the index finger and thumb sit on the -X side
  // of a right fist in fist frame, on +X for a left fist.
  const mx = side === 'right' ? 1 : -1;
  const parts: BufferGeometry[] = [];

  // Back of the hand / palm block.
  parts.push(new RoundedBoxGeometry(0.086, 0.032, 0.072, 2, 0.012).translate(0, 0.002, 0.03));

  // Four curled fingers: proximal phalanx (forms the flat front of the fist)
  // and middle phalanx tucked underneath towards the palm.
  const fingerX = [-0.0315, -0.0105, 0.0105, 0.0315]; // index .. pinky
  const proximalHeight = [0.048, 0.05, 0.048, 0.042];
  const yOffset = [0, 0, 0, 0.003];
  const zOffset = [0, -0.001, 0, 0.004];
  for (let i = 0; i < 4; i++) {
    const x = fingerX[i] * mx;
    const h = proximalHeight[i];
    parts.push(
      new RoundedBoxGeometry(0.0205, h, 0.024, 2, 0.0085).translate(x, 0.018 - h / 2 + yOffset[i], -0.016 + zOffset[i]),
    );
    parts.push(
      new RoundedBoxGeometry(0.0195, 0.019, 0.03, 2, 0.008).translate(x, 0.018 - h + 0.008 + yOffset[i], 0.0035 + zOffset[i]),
    );
  }

  // Thenar muscle at the base of the thumb.
  parts.push(new SphereGeometry(0.02, 12, 8).scale(1, 0.8, 1.3).translate(-0.036 * mx, -0.012, 0.04));

  // Thumb: metacarpal + distal segment wrapping across the front of the curled fingers.
  const thumbBase = new Vector3(-0.04 * mx, -0.012, 0.045);
  const thumbMid = new Vector3(-0.036 * mx, -0.03, 0.012);
  const thumbTip = new Vector3(-0.008 * mx, -0.04, -0.012);
  parts.push(capsuleBetween(thumbBase, thumbMid, 0.0115));
  parts.push(capsuleBetween(thumbMid, thumbTip, 0.0105));

  // Wrist / forearm stub (elliptical cross-section).
  parts.push(new CylinderGeometry(0.026, 0.029, 0.11, 14).rotateX(Math.PI / 2).scale(1.25, 0.85, 1).translate(0, 0, 0.115));

  const flat = parts.map(nonIndexed);
  const merged = mergeGeometries(flat, false);
  for (const g of flat) g.dispose();
  if (!merged) throw new Error('createFistGeometry: merge failed');
  merged.applyMatrix4(fistToGripMatrix(side));
  merged.computeBoundingSphere();
  return merged;
}

/** A fist mesh in grip space. Casts a shadow onto the canvas from the key light. */
export function createFistMesh(side: Handedness, material: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(createFistGeometry(side), material);
  mesh.name = `fist-${side}`;
  mesh.castShadow = true;
  mesh.renderOrder = -2; // nearest opaque geometry: draw first for early-Z
  return mesh;
}
