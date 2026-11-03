import { type BufferGeometry, Color, Float32BufferAttribute, Vector3 } from 'three';
import { smoothstep } from '../core/mathUtils';
import type { Handedness } from '../input/XRInput';
import { fistToGripMatrix } from './FistModel';
import type { GloveWeight } from './GearProfile';
import { bakeOcclusion, ellipsoid, ellipticCylinderZ, meshSdf, mirrorX, roundBox, roundCone, type Sdf, smin, ssub } from './SdfMesher';

/**
 * Procedural boxing glove for the player, sculpted in the same "fist frame"
 * as the bare fist (punch direction -Z, back of hand +Y, knuckle row along X,
 * wrist +Z; right hand, thumb on -X) as a signed distance field: a pillowy
 * padded head with a knuckle seam, a soft crease where the padding curls
 * under the fingers, an attached thumb, a cuff with a raised wrist strap and
 * an open, lined end. Meshed once, mirrored for the left hand, mapped into
 * WebXR grip space.
 *
 * Vertex colours hold the final colours (body, trim, lining, baked crease
 * shading); {@link paintGlove} repaints them for a glove colour. Per-vertex
 * region weights are kept in `geometry.userData.gloveRegions`. The opponent
 * wears the same glove, meshed coarser.
 */

/** Strike-sphere centre for a gloved hand, in fist-frame coordinates (middle of the padded front). */
export const GLOVE_STRIKE_CENTER_IN_FIST = new Vector3(0, -0.006, -0.012);

export function gloveStrikeCenterInGrip(side: Handedness): Vector3 {
  return GLOVE_STRIKE_CENTER_IN_FIST.clone().applyMatrix4(fistToGripMatrix(side));
}

/** Cuff ellipse (half axes) and where the strap and the open end sit along it. */
const CUFF = { rx: 0.047, ry: 0.042, cy: -0.004, z0: 0.06, z1: 0.19 };
const STRAP = { z0: 0.092, z1: 0.152, raise: 0.0045 };
const OPENING_Z = 0.172;

/** The right glove (10 oz) as a signed distance field. */
export const gloveSdf: Sdf = (x, y, z) => {
  // Padded head: a very rounded box, fuller over the knuckles.
  let d = roundBox(x, y, z, 0, -0.004, -0.016, 0.055, 0.049, 0.05, 0.04);
  d = smin(d, ellipsoid(x, y, z, 0, 0.004, -0.03, 0.056, 0.047, 0.038), 0.015);
  // Body over the back of the hand, tapering towards the wrist (a little wider than tall).
  d = smin(d, roundCone(x / 1.17, y, z, 0, 0, -0.005, 0.048, 0, -0.004, 0.08, 0.042), 0.026);
  // Seam across the back where the knuckle padding meets the hand padding.
  d = ssub(d, roundCone(x, y, z, -0.05, 0.0475, 0.03, 0.0045, 0.05, 0.0465, 0.03, 0.0045), 0.006);
  // Crease on the palm side where the padding curls under the fingertips.
  d = ssub(d, roundCone(x, y, z, -0.036, -0.058, 0.012, 0.009, 0.04, -0.056, 0.012, 0.009), 0.01);
  // Attached thumb along the index side.
  d = smin(d, roundCone(x, y, z, -0.047, -0.016, 0.05, 0.022, -0.052, -0.01, -0.016, 0.019), 0.005);
  // Cuff, then the raised wrist strap around it.
  d = smin(d, ellipticCylinderZ(x, y, z, 0, CUFF.cy, CUFF.rx, CUFF.ry, CUFF.z0, CUFF.z1, 0.012), 0.018);
  const strap = ellipticCylinderZ(
    x, y, z, 0, CUFF.cy, CUFF.rx + STRAP.raise, CUFF.ry + STRAP.raise, STRAP.z0, STRAP.z1, 0.004,
  );
  d = smin(d, strap, 0.002);
  // Open end of the cuff, with a rolled lip.
  d = ssub(d, ellipticCylinderZ(x, y, z, 0, CUFF.cy, CUFF.rx - 0.009, CUFF.ry - 0.009, OPENING_Z, 0.25, 0.004), 0.004);
  return d;
};

const GLOVE_BOUNDS = { min: new Vector3(-0.08, -0.064, -0.074), max: new Vector3(0.066, 0.06, 0.2) };
/** Grid spacing for the player's gloves (seen from centimetres away) and the opponent's. */
const GLOVE_CELL = 0.0035;
export const FAR_GLOVE_CELL = 0.0055;

/** Region weights per vertex: body, trim (strap, lip, badge), lining, then baked occlusion. */
const REGION_STRIDE = 4;

const _p = new Vector3();

function computeRegions(geometry: BufferGeometry): Float32Array {
  const pos = geometry.getAttribute('position');
  const ao = bakeOcclusion(gloveSdf, geometry, 0.0045);
  const regions = new Float32Array(pos.count * REGION_STRIDE);
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i);
    const radial = Math.hypot(_p.x / CUFF.rx, (_p.y - CUFF.cy) / CUFF.ry);
    const lining = _p.z > OPENING_Z - 0.004 && radial < 0.86 ? 1 : 0;
    const strap = smoothstep(STRAP.z0 - 0.002, STRAP.z0 + 0.002, _p.z) * smoothstep(STRAP.z1 + 0.002, STRAP.z1 - 0.002, _p.z);
    const lip = smoothstep(CUFF.z1 - 0.008, CUFF.z1 - 0.005, _p.z);
    // Oval badge on the back of the hand, near the cuff.
    const badge = smoothstep(0.02, 0.03, _p.y) * smoothstep(1.2, 0.9, Math.hypot(_p.x / 0.019, (_p.z - 0.048) / 0.012));
    const trim = (1 - lining) * Math.min(1, strap + lip + badge);
    const o = i * REGION_STRIDE;
    regions[o] = (1 - lining) * (1 - trim);
    regions[o + 1] = trim;
    regions[o + 2] = lining;
    regions[o + 3] = ao[i];
  }
  return regions;
}

const LINING = new Color(0x1a1a1c);
const _body = new Color();
const _trim = new Color();

/**
 * Paints the glove's vertex colours (sRGB hex body and trim colours). The
 * default neutral white/grey suits instanced copies tinted by instance colour.
 */
export function paintGlove(geometry: BufferGeometry, body = 0xffffff, trim = 0xe6e6e6): void {
  const regions = geometry.userData.gloveRegions as Float32Array;
  _body.setHex(body);
  _trim.setHex(trim);
  const count = regions.length / REGION_STRIDE;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const o = i * REGION_STRIDE;
    const shade = 0.5 + 0.5 * regions[o + 3];
    for (let c = 0; c < 3; c++) {
      const body = c === 0 ? _body.r : c === 1 ? _body.g : _body.b;
      const trim = c === 0 ? _trim.r : c === 1 ? _trim.g : _trim.b;
      const lining = c === 0 ? LINING.r : c === 1 ? LINING.g : LINING.b;
      colors[i * 3 + c] = (regions[o] * body + regions[o + 1] * trim + regions[o + 2] * lining) * shade;
    }
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
}

/** Size of a glove relative to the 10 oz model (heavier gloves have more padding). */
export function gloveScale(weight: GloveWeight): number {
  return 1 + ((weight - 10) / 6) * 0.12;
}

/** Right gloves meshed so far, by grid spacing. */
const meshed = new Map<number, BufferGeometry>();

/**
 * The glove in fist-frame coordinates, painted neutral. Heavier gloves are the
 * same glove scaled up around the strike centre (more padding).
 */
export function createGloveInFistFrame(side: Handedness, weight: GloveWeight, cell = GLOVE_CELL): BufferGeometry {
  let right = meshed.get(cell);
  if (!right) {
    right = meshSdf(gloveSdf, { ...GLOVE_BOUNDS, cell });
    right.userData.gloveRegions = computeRegions(right);
    meshed.set(cell, right);
  }
  const geometry = side === 'right' ? right.clone() : mirrorX(right);
  geometry.userData.gloveRegions = right.userData.gloveRegions;
  const s = gloveScale(weight);
  const c = GLOVE_STRIKE_CENTER_IN_FIST;
  geometry.translate(-c.x, -c.y, -c.z).scale(s, s, s).translate(c.x, c.y, c.z);
  paintGlove(geometry);
  return geometry;
}

/** Builds the player's glove (one draw call) in grip space, painted neutral. */
export function createGloveGeometry(side: Handedness, weight: GloveWeight): BufferGeometry {
  const geometry = createGloveInFistFrame(side, weight);
  geometry.applyMatrix4(fistToGripMatrix(side));
  geometry.computeBoundingSphere();
  return geometry;
}
