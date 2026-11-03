import { type BufferGeometry, Color, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import { smoothstep } from '../core/mathUtils';
import type { Handedness } from '../input/XRInput';
import { bakeOcclusion, ellipsoid, ellipticCylinderZ, meshSdf, mirrorX, roundCone, type Sdf, smin } from './SdfMesher';

/**
 * Procedural bare-fist model, authored directly in WebXR grip space so it can
 * be driven by `renderer.xr.getControllerGrip()` with no extra offsets.
 *
 * Grip space (WebXR spec): origin at the centre of the curled fingers, -Z
 * along the held "rod" towards the thumb, +X out of the back of the right hand
 * (-X for the left), +Y back along the forearm — so the punching face of the
 * fist points along -Y.
 *
 * The fist is sculpted in a friendlier "fist frame" (punch direction -Z, back
 * of the hand +Y, knuckle row along X, wrist towards +Z; right hand, with the
 * index finger and thumb on -X) as a signed distance field — knuckles, three
 * phalanges per finger, palm pads, a wrapped thumb, tendons and the wrist bone
 * blended into one skin — then meshed, shaded (redder knuckles, paler palm,
 * thumbnail, baked crease occlusion into vertex colours) and rotated into grip
 * space. The left hand is the mirror image.
 */

export const PLAYER_SKIN_COLOR = 0xc89274;

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

// --- Anatomy (right fist, fist frame, metres) ------------------------------------------

interface Finger {
  /** Knuckle (metacarpal head), middle and end joints, and the tucked fingertip. */
  readonly mcp: Vector3;
  readonly pip: Vector3;
  readonly dip: Vector3;
  readonly tip: Vector3;
  readonly radius: number;
  /** Bounding sphere of the whole finger, to skip it where it can't change the field. */
  readonly center: Vector3;
  readonly reach: number;
}

/** Index, middle, ring, pinky: the middle knuckle stands proudest, the pinky sits lower and back. */
const FINGERS: readonly Finger[] = [
  [-0.0285, 0.0105, -0.017, 0.04, 0.0098],
  [-0.0095, 0.0108, -0.0185, 0.043, 0.0102],
  [0.0095, 0.0098, -0.017, 0.041, 0.0097],
  [0.0283, 0.0068, -0.0125, 0.034, 0.0087],
].map(([x, y, z, length, radius]) => {
  const mcp = new Vector3(x, y, z);
  const pip = new Vector3(x, y - length, z - 0.002);
  const dip = new Vector3(x, pip.y - 0.001, pip.z + (radius > 0.009 ? 0.024 : 0.019));
  const tip = new Vector3(x, dip.y + 0.014, dip.z + 0.006);
  const center = mcp.clone().add(pip).add(dip).add(tip).multiplyScalar(0.25);
  const reach = Math.max(...[mcp, pip, dip, tip].map((j) => j.distanceTo(center))) + radius * 1.12;
  return { mcp, pip, dip, tip, radius, center, reach };
});

/** Thumb joints: base of the metacarpal, knuckle, middle joint and tip (wrapped under the index and middle fingers). */
const THUMB = {
  base: new Vector3(-0.026, -0.006, 0.054),
  mcp: new Vector3(-0.041, -0.025, 0.018),
  ip: new Vector3(-0.031, -0.04, -0.006),
  tip: new Vector3(-0.012, -0.0435, -0.016),
};
/** Head of the ulna, the wrist bump on the little-finger side. */
const ULNA = new Vector3(0.029, 0.008, 0.06);
/** Bounding sphere of the thumb's last two segments. */
const THUMB_CENTER = THUMB.mcp.clone().add(THUMB.ip).add(THUMB.tip).divideScalar(3);
const THUMB_REACH = Math.max(...[THUMB.mcp, THUMB.ip, THUMB.tip].map((j) => j.distanceTo(THUMB_CENTER))) + 0.0112;
/** Box around the tendons (min x, y, z, max x, y, z). */
const TENDON_BOX = [-0.041, 0.007, -0.0115, 0.041, 0.018, 0.061];

const cone = (x: number, y: number, z: number, a: Vector3, ra: number, b: Vector3, rb: number): number =>
  roundCone(x, y, z, a.x, a.y, a.z, ra, b.x, b.y, b.z, rb);
const ball = (x: number, y: number, z: number, c: Vector3, r: number): number =>
  Math.hypot(x - c.x, y - c.y, z - c.z) - r;

/** The right fist as a signed distance field. */
export const fistSdf: Sdf = (x, y, z) => {
  // Back of the hand (domed), palm, and the fleshy pads at its heel.
  let palm = ellipsoid(x, y, z, 0.001, 0.0025, 0.022, 0.041, 0.0135, 0.041);
  palm = smin(palm, ellipsoid(x, y, z, 0.002, -0.012, 0.03, 0.04, 0.017, 0.036), 0.01);
  palm = smin(palm, ellipsoid(x, y, z, 0.028, -0.017, 0.038, 0.015, 0.014, 0.026), 0.01);
  palm = smin(palm, ellipsoid(x, y, z, -0.03, -0.016, 0.036, 0.018, 0.017, 0.026), 0.01);
  // Thumb metacarpal grows out of the thenar pad.
  palm = smin(palm, cone(x, y, z, THUMB.base, 0.0125, THUMB.mcp, 0.0115), 0.01);
  // Extensor tendons fanning from the wrist to the knuckles. (A part further than the blend
  // radius beyond the current value can't change a smooth union, so far-away parts are skipped.)
  if (boxDistance(x, y, z, TENDON_BOX) < palm + 0.006) {
    for (const f of FINGERS) {
      palm = smin(palm, roundCone(x, y, z, f.mcp.x * 0.35, 0.013, 0.058, 0.0028, f.mcp.x, 0.0145, -0.008, 0.0032), 0.006);
    }
  }
  // Wrist and forearm, with the bump of the ulna on the little-finger side.
  palm = smin(palm, ellipticCylinderZ(x, y, z, 0, -0.002, 0.032, 0.0225, 0.05, 0.165, 0.01), 0.014);
  palm = smin(palm, ball(x, y, z, ULNA, 0.0065), 0.006);

  // Curled fingers: each finger is smooth along its own joints, with crisp creases between fingers.
  let fingers = Infinity;
  for (const f of FINGERS) {
    if (ball(x, y, z, f.center, f.reach) > Math.min(fingers, palm + 0.007) + 0.0025) continue;
    const r = f.radius;
    let d = ball(x, y, z, f.mcp, r * 1.12);
    d = smin(d, cone(x, y, z, f.mcp, r, f.pip, r * 0.93), 0.003);
    d = smin(d, ball(x, y, z, f.pip, r), 0.003);
    d = smin(d, cone(x, y, z, f.pip, r * 0.93, f.dip, r * 0.85), 0.003);
    d = smin(d, cone(x, y, z, f.dip, r * 0.85, f.tip, r * 0.78), 0.003);
    fingers = smin(fingers, d, 0.0025);
  }
  let hand = smin(palm, fingers, 0.007);

  // Thumb pressed across the front of the middle phalanges.
  if (ball(x, y, z, THUMB_CENTER, THUMB_REACH) > hand + 0.004) return hand;
  let thumb = cone(x, y, z, THUMB.mcp, 0.0112, THUMB.ip, 0.0102);
  thumb = smin(thumb, cone(x, y, z, THUMB.ip, 0.0102, THUMB.tip, 0.0092), 0.003);
  hand = smin(hand, thumb, 0.004);
  return hand;
};

/** Distance from a point to an axis-aligned box (0 inside): a lower bound for anything in the box. */
function boxDistance(x: number, y: number, z: number, b: readonly number[]): number {
  const dx = Math.max(b[0] - x, 0, x - b[3]);
  const dy = Math.max(b[1] - y, 0, y - b[4]);
  const dz = Math.max(b[2] - z, 0, z - b[5]);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

const FIST_BOUNDS = { min: new Vector3(-0.062, -0.062, -0.038), max: new Vector3(0.05, 0.036, 0.18) };
const FIST_CELL = 0.0025;

const _p = new Vector3();
const _n = new Vector3();
const _d = new Vector3();
const _r = new Vector3();

/** Vertex colours: skin with redder knuckles, a paler palm, the thumbnail, and baked crease shading. */
function shadeFist(geometry: BufferGeometry): void {
  const base = new Color(PLAYER_SKIN_COLOR);
  const knuckle = new Color(0xc47a66);
  const palmTone = new Color(0xd7a58c);
  const nail = new Color(0xe0b2a4);
  const ao = bakeOcclusion(fistSdf, geometry, 0.0028);
  const pos = geometry.getAttribute('position');
  const nor = geometry.getAttribute('normal');
  const colors = new Float32Array(pos.count * 3);
  const c = new Color();
  // The thumbnail: an oval on the outer face of the last thumb segment.
  const nailNormal = new Vector3(-0.25, -0.75, -0.6).normalize();
  const thumbAxis = new Vector3().subVectors(THUMB.tip, THUMB.ip).normalize();
  const nailCenter = THUMB.ip.clone().lerp(THUMB.tip, 0.62).addScaledVector(nailNormal, 0.0095);
  for (let i = 0; i < pos.count; i++) {
    _p.fromBufferAttribute(pos, i);
    _n.fromBufferAttribute(nor, i);
    c.copy(base);
    // Knuckles and finger joints: thinner skin, redder.
    let joint = 0;
    for (const f of FINGERS) {
      joint = Math.max(joint, Math.exp(-_p.distanceToSquared(f.mcp) / (0.011 * 0.011)), 0.7 * Math.exp(-_p.distanceToSquared(f.pip) / (0.01 * 0.01)));
    }
    c.lerp(knuckle, 0.45 * joint);
    // Palm side is paler.
    c.lerp(palmTone, 0.35 * smoothstep(-0.2, -0.75, _n.y) * smoothstep(-0.012, 0.004, _p.z));
    _r.subVectors(_p, nailCenter);
    const along = _r.dot(thumbAxis);
    const across = _d.copy(_r).addScaledVector(thumbAxis, -along).length();
    const nailMask = smoothstep(1, 0.75, Math.hypot(along / 0.0078, across / 0.0062)) * smoothstep(0.2, 0.5, _n.dot(nailNormal));
    c.lerp(nail, 0.7 * nailMask);
    const shade = 0.45 + 0.55 * ao[i];
    colors.set([c.r * shade, c.g * shade, c.b * shade], i * 3);
  }
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
}

let rightFist: BufferGeometry | null = null;

/** Builds the fist geometry (one draw call, vertex coloured) in grip space. Meshed once, mirrored for the left. */
export function createFistGeometry(side: Handedness): BufferGeometry {
  if (!rightFist) {
    rightFist = meshSdf(fistSdf, { ...FIST_BOUNDS, cell: FIST_CELL });
    shadeFist(rightFist);
  }
  const geometry = side === 'right' ? rightFist.clone() : mirrorX(rightFist);
  geometry.applyMatrix4(fistToGripMatrix(side));
  geometry.computeBoundingSphere();
  return geometry;
}
