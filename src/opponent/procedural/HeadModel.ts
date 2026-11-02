import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { clamp, createSmoothCurve, smoothstep, sq } from '../../core/mathUtils';

/**
 * Parametric head for the procedural opponent.
 *
 * The head is a stack of horizontal superellipse slices (side profile, back
 * profile and width curves taken from adult male proportions) with facial
 * features added as smooth displacements. One parameterisation drives:
 *  - the mesh (vertex grid),
 *  - its UVs (so the face gets a large share of texture space),
 *  - the skin texture painter and the face-region UV mask,
 * which guarantees that the painted face, the geometry and the damage regions
 * always line up.
 *
 * Head space: metres relative to the skull centre at eye level.
 * +x = the character's left, +y = up, +z = forward (out of the face).
 *
 * Parameters: `s` in [-1, 1] around the head (0 = front centre, ±1 = back seam)
 * maps to the slice angle `t`; `y` is the slice height. UV = ((s + 1) / 2, v(y)).
 */

// ---------------------------------------------------------------------------
// Profile curves (y ascending)
// ---------------------------------------------------------------------------

const PROFILE_Y = [-0.14, -0.128, -0.118, -0.105, -0.09, -0.075, -0.06, -0.045, -0.03, -0.01, 0, 0.018, 0.04, 0.07, 0.095, 0.112, 0.122, 0.128];
/** Depth of the front of the slice (face profile without the nose). */
const frontDepth = createSmoothCurve(PROFILE_Y, [0.012, 0.054, 0.08, 0.088, 0.088, 0.088, 0.086, 0.087, 0.089, 0.087, 0.084, 0.093, 0.092, 0.083, 0.064, 0.042, 0.02, 0.002]);
/** Depth of the back of the slice (skull and nape). */
const backDepth = createSmoothCurve(PROFILE_Y, [0.03, 0.034, 0.038, 0.044, 0.056, 0.07, 0.084, 0.094, 0.1, 0.104, 0.105, 0.106, 0.105, 0.098, 0.082, 0.058, 0.032, 0.004]);
/** Half width of the slice. */
const halfWidth = createSmoothCurve(PROFILE_Y, [0.02, 0.034, 0.042, 0.05, 0.058, 0.064, 0.068, 0.07, 0.073, 0.075, 0.076, 0.077, 0.077, 0.072, 0.06, 0.044, 0.026, 0.003]);
/** Superellipse exponent: < 1 squares off the slice (flatter face front and sides). */
const squareness = createSmoothCurve(PROFILE_Y, [1, 0.95, 0.9, 0.85, 0.82, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.82, 0.85, 0.88, 0.92, 0.95, 1, 1]);

/** Nose projection along the midline, by height (columella → tip → bridge). */
const noseAmp = createSmoothCurve(
  [-0.058, -0.053, -0.047, -0.041, -0.03, -0.012, 0.004, 0.016],
  [0, 0.011, 0.023, 0.026, 0.021, 0.0135, 0.0085, 0],
);
const noseWidth = createSmoothCurve([-0.057, -0.045, -0.03, 0, 0.016], [0.016, 0.0145, 0.0105, 0.0085, 0.008]);

export const HEAD_Y_MIN = -0.14;
export const HEAD_Y_MAX = 0.128;

// ---------------------------------------------------------------------------
// Eyes
// ---------------------------------------------------------------------------

export const EYE_X = 0.034;
export const EYE_Y = 0.001;
export const EYE_RADIUS = 0.0118;
const LID_BULGE = 0.0035;
const ALMOND_HALF_WIDTH = 0.0155;
const ALMOND_HALF_HEIGHT_UP = 0.0062;
const ALMOND_HALF_HEIGHT_DOWN = 0.0048;

/** 1 inside the eye opening (almond), 0 outside, soft edge. `dx` is measured from the eye centre. */
export function almondMask(dx: number, dy: number): number {
  const nx = dx / ALMOND_HALF_WIDTH;
  const ny = dy / (dy > 0 ? ALMOND_HALF_HEIGHT_UP : ALMOND_HALF_HEIGHT_DOWN);
  // |ny| + nx² <= 1 gives pointed corners and a rounded arch.
  const d = Math.abs(ny) + nx * nx;
  return 1 - smoothstep(0.72, 1.0, d);
}

// ---------------------------------------------------------------------------
// Parameter mappings
// ---------------------------------------------------------------------------

/** Fraction of linear vs quadratic in the s → t mapping (denser columns at the front). */
const S_LINEAR = 0.35;

export function angleFromS(s: number): number {
  return Math.PI * (S_LINEAR * s + (1 - S_LINEAR) * s * Math.abs(s));
}

export function sFromAngle(t: number): number {
  const r = Math.min(1, Math.abs(t) / Math.PI);
  const a = S_LINEAR;
  const s = (-a + Math.sqrt(a * a + 4 * (1 - a) * r)) / (2 * (1 - a));
  return Math.sign(t) * s;
}

/** Vertical spacing of slices: dense around the eyes, fine over the face, coarse elsewhere. */
function ringSpacing(y: number): number {
  if (Math.abs(y - EYE_Y) < 0.011) return 0.0014;
  if (y > -0.096 && y < 0.032) return 0.0023;
  return 0.0045;
}

function buildRingHeights(): number[] {
  const rings: number[] = [];
  let y = HEAD_Y_MIN;
  while (y < HEAD_Y_MAX - 0.001) {
    rings.push(y);
    y += ringSpacing(y);
  }
  rings.push(HEAD_Y_MAX);
  return rings;
}

/** Slice heights; v = index / (count - 1). */
export const HEAD_RINGS: readonly number[] = buildRingHeights();
export const HEAD_COLUMNS = 128;

export function yFromV(v: number): number {
  const f = clamp(v, 0, 1) * (HEAD_RINGS.length - 1);
  const i = Math.min(HEAD_RINGS.length - 2, Math.floor(f));
  return HEAD_RINGS[i] + (HEAD_RINGS[i + 1] - HEAD_RINGS[i]) * (f - i);
}

export function vFromY(y: number): number {
  const rings = HEAD_RINGS;
  if (y <= rings[0]) return 0;
  if (y >= rings[rings.length - 1]) return 1;
  let lo = 0;
  let hi = rings.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (rings[mid] <= y) lo = mid;
    else hi = mid;
  }
  return (lo + (y - rings[lo]) / (rings[hi] - rings[lo])) / (rings.length - 1);
}

// ---------------------------------------------------------------------------
// Surface evaluation
// ---------------------------------------------------------------------------

export interface SurfaceSample {
  /** Base (featureless) surface point. */
  readonly base: Vector3;
  /** Approximate outward normal of the base slice (horizontal). */
  readonly normal: Vector3;
  /** Lateral position on the base surface (= base.x). */
  x: number;
  /** 0 at the sides/back, 1 at the front centre. */
  front: number;
}

/** Base superellipse slice point for angle t (0 = front) at height y. */
export function sampleBase(t: number, y: number, out: SurfaceSample): SurfaceSample {
  const w = halfWidth(y);
  const e = squareness(y);
  const s = Math.sin(t);
  const c = Math.cos(t);
  const depth = c >= 0 ? frontDepth(y) : backDepth(y);
  const x = w * Math.sign(s) * Math.pow(Math.abs(s), e);
  const z = depth * Math.sign(c) * Math.pow(Math.abs(c), e);
  out.base.set(x, y, z);
  const nx = (Math.sign(s) * Math.pow(Math.abs(s), 2 - e)) / w;
  const nz = (Math.sign(c) * Math.pow(Math.abs(c), 2 - e)) / Math.max(depth, 1e-4);
  out.normal.set(nx, 0, nz).normalize();
  out.x = x;
  out.front = Math.max(0, c);
  return out;
}

export function createSample(): SurfaceSample {
  return { base: new Vector3(), normal: new Vector3(), x: 0, front: 0 };
}

/** Slice angle whose base surface has lateral position x at height y. */
export function angleForLateral(x: number, y: number): number {
  const r = clamp(Math.abs(x) / halfWidth(y), 0, 1);
  return Math.sign(x) * Math.asin(Math.pow(r, 1 / squareness(y)));
}

/**
 * Facial feature displacement (metres along the slice normal).
 * @param withAlmonds include the eye-opening cut (off when placing the eyeballs)
 */
export function featureDisplacement(x: number, y: number, front: number, withAlmonds = true): number {
  if (front <= 0) return 0;
  const ax = Math.abs(x);
  let d = 0;

  // Nose: midline ridge plus the nostril wings (alae).
  d += noseAmp(y) * Math.exp(-sq(x / noseWidth(y)));
  d += 0.0075 * Math.exp(-sq((ax - 0.0165) / 0.0062) - sq((y + 0.046) / 0.0075));

  // Eyes: puffy lids around the eyeball, and the opening the eyeball shows through.
  for (const side of [1, -1]) {
    const dx = x - side * EYE_X;
    const dy = y - EYE_Y;
    d += LID_BULGE * Math.exp(-sq(dx / 0.017) - sq(dy / 0.012));
    if (withAlmonds) d -= 0.011 * almondMask(dx * side, dy);
  }

  // Brow ridge, cheekbones, and the hollow beside the nose.
  d += 0.0035 * Math.exp(-sq((y - 0.017) / 0.0065) - sq(x / 0.06));
  d += 0.0055 * Math.exp(-sq((ax - 0.051) / 0.017) - sq((y + 0.024) / 0.016));
  d -= 0.0025 * Math.exp(-sq((ax - 0.026) / 0.008) - sq((y + 0.056) / 0.012));

  // Lips and the line between them, then the chin.
  d += 0.0055 * Math.exp(-sq((y + 0.0665) / 0.0055) - Math.pow(x / 0.025, 4));
  d += 0.0068 * Math.exp(-sq((y + 0.0815) / 0.006) - Math.pow(x / 0.023, 4));
  d -= 0.0022 * Math.exp(-sq((y + 0.0745) / 0.0018) - Math.pow(x / 0.026, 6));
  d += 0.0065 * Math.exp(-sq(x / 0.02) - sq((y + 0.108) / 0.012));

  return d * smoothstep(0, 0.35, front);
}

/** Final surface point (base + features) for parameter (t, y). */
export function headPoint(t: number, y: number, sample: SurfaceSample, out: Vector3): Vector3 {
  sampleBase(t, y, sample);
  const d = featureDisplacement(sample.x, y, sample.front);
  return out.copy(sample.base).addScaledVector(sample.normal, d);
}

/** Eyeball centre for one side (+1 = character's left), so its front sits just behind the lid surface. */
export function eyeCenter(side: 1 | -1, out: Vector3): Vector3 {
  const sample = createSample();
  sampleBase(angleForLateral(side * EYE_X, EYE_Y), EYE_Y, sample);
  const surface = featureDisplacement(sample.x, EYE_Y, sample.front, false);
  return out.copy(sample.base).addScaledVector(sample.normal, surface - 0.0012 - EYE_RADIUS);
}

/** Head UV for a point near the surface (by its lateral position and height). */
export function headUV(x: number, y: number): [number, number] {
  return [(sFromAngle(angleForLateral(x, y)) + 1) / 2, vFromY(y)];
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface HeadGeometry {
  readonly geometry: BufferGeometry;
  /** Per-vertex weight (0..1) of the jaw bone; the rest belongs to the head bone. */
  readonly jawWeights: Float32Array;
}

/** Builds the head mesh in head space with parameter UVs (0..1). */
export function buildHeadGeometry(): HeadGeometry {
  const rings = HEAD_RINGS;
  const cols = HEAD_COLUMNS;
  const ringCount = rings.length;
  const gridCount = ringCount * (cols + 1);
  const vertexCount = gridCount + 2; // + bottom and top apex
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const jaw = new Float32Array(vertexCount);
  const sample = createSample();
  const p = new Vector3();

  for (let i = 0; i < ringCount; i++) {
    const y = rings[i];
    const v = i / (ringCount - 1);
    for (let j = 0; j <= cols; j++) {
      const s = -1 + (2 * j) / cols;
      headPoint(angleFromS(s), y, sample, p);
      const k = i * (cols + 1) + j;
      positions.set([p.x, p.y, p.z], k * 3);
      uvs.set([(s + 1) / 2, v], k * 2);
      jaw[k] = smoothstep(-0.072, -0.088, y) * smoothstep(0.15, 0.55, sample.front);
    }
  }

  // Apex vertices close the bottom (hidden inside the neck) and the crown.
  const apex = (ring: number, dy: number, index: number, v: number): void => {
    let cx = 0;
    let cz = 0;
    for (let j = 0; j < cols; j++) {
      const k = (ring * (cols + 1) + j) * 3;
      cx += positions[k];
      cz += positions[k + 2];
    }
    positions.set([cx / cols, rings[ring] + dy, cz / cols], index * 3);
    uvs.set([0.5, v], index * 2);
  };
  const bottom = gridCount;
  const top = gridCount + 1;
  apex(0, -0.003, bottom, 0);
  apex(ringCount - 1, 0.0015, top, 1);

  const indices: number[] = [];
  for (let i = 0; i < ringCount - 1; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * (cols + 1) + j;
      const b = a + 1;
      const c = a + cols + 1;
      const d = c + 1;
      // Columns run towards +x (the character's left, which a viewer facing the
      // character sees on their right), rings run up: CCW seen from outside.
      indices.push(a, b, d, a, d, c);
    }
  }
  const lastRing = (ringCount - 1) * (cols + 1);
  for (let j = 0; j < cols; j++) {
    indices.push(bottom, j + 1, j);
    indices.push(lastRing + j, lastRing + j + 1, top);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  averageSeamNormals(geometry, ringCount, cols);
  return { geometry, jawWeights: jaw };
}

/** The back seam has duplicated vertices; give both copies the same normal. */
function averageSeamNormals(geometry: BufferGeometry, ringCount: number, cols: number): void {
  const n = geometry.getAttribute('normal');
  const a = new Vector3();
  const b = new Vector3();
  for (let i = 0; i < ringCount; i++) {
    const first = i * (cols + 1);
    const last = first + cols;
    a.fromBufferAttribute(n, first);
    b.fromBufferAttribute(n, last);
    a.add(b).normalize();
    n.setXYZ(first, a.x, a.y, a.z);
    n.setXYZ(last, a.x, a.y, a.z);
  }
  n.needsUpdate = true;
}
