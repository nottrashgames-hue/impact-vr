import {
  type BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Quaternion,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Handedness } from '../input/XRInput';
import { fistToGripMatrix } from './FistModel';
import type { GloveWeight } from './GearProfile';

/**
 * Procedural boxing glove for the player, authored in the same "fist frame"
 * as the bare fist (punch direction -Z, back of hand +Y, knuckle row along X,
 * wrist +Z) and mapped into WebXR grip space. Vertex colours: white = takes
 * the glove colour (material colour), the trim stays light grey.
 */

const TRIM = new Color(0.82, 0.82, 0.82);
const BODY = new Color(1, 1, 1);

function colored(geometry: BufferGeometry, color: Color): BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const count = g.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([color.r, color.g, color.b], i * 3);
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return g;
}

/** Strike-sphere centre for a gloved hand, in fist-frame coordinates (middle of the padded front). */
export const GLOVE_STRIKE_CENTER_IN_FIST = new Vector3(0, -0.006, -0.012);

export function gloveStrikeCenterInGrip(side: Handedness): Vector3 {
  return GLOVE_STRIKE_CENTER_IN_FIST.clone().applyMatrix4(fistToGripMatrix(side));
}

/** Builds the glove (one draw call) in grip space. Heavier gloves are slightly bigger. */
export function createGloveGeometry(side: Handedness, weight: GloveWeight): BufferGeometry {
  const s = 1 + ((weight - 10) / 6) * 0.12;
  const mx = side === 'right' ? 1 : -1;
  const parts: BufferGeometry[] = [];

  // Padded mitt: wider than the hand, rounded front.
  parts.push(
    colored(new RoundedBoxGeometry(0.105 * s, 0.092 * s, 0.135 * s, 4, 0.04 * s).translate(0, -0.004, 0.012), BODY),
  );
  // Knuckle pad bulge.
  parts.push(colored(new RoundedBoxGeometry(0.1 * s, 0.07 * s, 0.05 * s, 3, 0.025 * s).translate(0, 0.006, -0.045 * s), BODY));

  // Thumb along the index side, attached to the mitt.
  const a = new Vector3(-0.05 * mx * s, -0.02, 0.05);
  const b = new Vector3(-0.045 * mx * s, -0.035, -0.02);
  const dir = new Vector3().subVectors(b, a);
  parts.push(
    colored(
      new CapsuleGeometry(0.022 * s, dir.length(), 4, 10)
        .applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize()))
        .translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2),
      BODY,
    ),
  );

  // Cuff up the wrist, with a contrasting band.
  parts.push(
    colored(new CylinderGeometry(0.048 * s, 0.052 * s, 0.1, 18).rotateX(Math.PI / 2).scale(1.1, 0.9, 1).translate(0, 0, 0.12), BODY),
  );
  parts.push(
    colored(new CylinderGeometry(0.0535 * s, 0.0535 * s, 0.024, 18).rotateX(Math.PI / 2).scale(1.1, 0.9, 1).translate(0, 0, 0.1), TRIM),
  );

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('createGloveGeometry: merge failed');
  merged.applyMatrix4(fistToGripMatrix(side));
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}
