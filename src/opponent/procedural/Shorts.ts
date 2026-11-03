import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { SHORTS_CROTCH_Y, SHORTS_LEG_RINGS, SHORTS_PELVIS_RINGS } from './BodyLayout';
import type { LoftRing } from './geometryBuilders';

/**
 * Boxing trunks as one continuous surface: a waist tube that splits at the
 * crotch into two leg tubes. Each leg's top ring reuses the waist's bottom
 * vertices on its side and closes along a crotch seam on the midline shared
 * with the other leg, so the parts meet exactly instead of overlapping (the
 * old separate sleeves poked out of the pelvis piece with a visible rim).
 */
export interface ShortsGeometry {
  /** UV 0..1: u around (front centre 0.5, seam at the back), v up from the crotch to the waistband. */
  readonly waist: BufferGeometry;
  /** UV 0..1 per leg: u around from the inner (crotch-side) seam, outer side at 0.5; v up from the hem. */
  readonly left: BufferGeometry;
  readonly right: BufferGeometry;
}

const WAIST_SEGMENTS = 64;
/** Vertices on each half (front, back) of the crotch seam. */
const SEAM_SEGMENTS = 7;
/** Rings blending from the crotch seam down into the first full leg ring. */
const BLEND_RINGS = 3;

function ellipsePoint(r: LoftRing, angle: number, y: number, out: Vector3): Vector3 {
  return out.set(r.rx * Math.sin(angle) + (r.dx ?? 0), y, r.rz * Math.cos(angle) + (r.dz ?? 0));
}

function waistAngle(j: number): number {
  return -Math.PI + (2 * Math.PI * j) / WAIST_SEGMENTS;
}

/**
 * @param hip   left hip joint (character rest space)
 * @param ankle left ankle joint; the leg tubes follow the hip-to-ankle line
 */
export function buildShortsGeometry(hip: Vector3, ankle: Vector3): ShortsGeometry {
  const waistRings = SHORTS_PELVIS_RINGS;
  const split = waistRings[0];
  const top = waistRings[waistRings.length - 1];

  // Waist ------------------------------------------------------------------------
  const waistPos: number[] = [];
  const waistUv: number[] = [];
  const p = new Vector3();
  for (const ring of waistRings) {
    for (let j = 0; j <= WAIST_SEGMENTS; j++) {
      ellipsePoint(ring, waistAngle(j), ring.y, p);
      waistPos.push(p.x, p.y, p.z);
      waistUv.push(j / WAIST_SEGMENTS, (ring.y - split.y) / (top.y - split.y));
    }
  }
  const waist = indexedTube(waistPos, waistUv, waistRings.length, WAIST_SEGMENTS + 1, false);

  // Left leg -----------------------------------------------------------------------
  const dir = new Vector3().subVectors(ankle, hip).normalize();
  const legCenter = (ring: LoftRing): Vector3 => {
    const t = ring.y / dir.y; // ring.y is negative (below the hip) and dir.y ≈ -1
    return new Vector3(hip.x + dir.x * t, hip.y + ring.y, hip.z + dir.z * t);
  };
  const full = SHORTS_LEG_RINGS[SHORTS_LEG_RINGS.length - 1]; // first complete ring under the crotch
  const fullCenter = legCenter(full);

  // Crotch seam on the midline (x = 0) from the back centre to the front centre, dipping to the crotch.
  const zBack = split.rz * Math.cos(Math.PI) + (split.dz ?? 0);
  const zFront = split.rz + (split.dz ?? 0);
  const zMid = (zFront + zBack) / 2;
  const halfSpan = (zFront - zBack) / 2;
  const seamY = (z: number): number => {
    const u = Math.min(1, Math.abs((z - zMid) / halfSpan));
    return split.y - (split.y - SHORTS_CROTCH_Y) * Math.pow(1 - u * u, 0.35);
  };

  // The top ring of the leg, in order of increasing angle around the leg starting at the inner seam point.
  const seam: Vector3[] = [];
  const zInner = fullCenter.z;
  seam.push(new Vector3(0, seamY(zInner), zInner));
  for (let k = 1; k < SEAM_SEGMENTS; k++) {
    // Denser towards the waist, where the seam climbs steeply.
    const z = zInner + (zFront - zInner) * Math.sin((Math.PI / 2) * (k / SEAM_SEGMENTS));
    seam.push(new Vector3(0, seamY(z), z));
  }
  for (let j = WAIST_SEGMENTS / 2; j <= WAIST_SEGMENTS; j++) {
    seam.push(ellipsePoint(split, waistAngle(j), split.y, new Vector3()));
  }
  for (let k = 1; k < SEAM_SEGMENTS; k++) {
    const z = zBack + (zInner - zBack) * (1 - Math.cos((Math.PI / 2) * (k / SEAM_SEGMENTS)));
    seam.push(new Vector3(0, seamY(z), z));
  }
  seam.push(seam[0].clone()); // UV seam: same point, u = 1

  // Angle of each seam vertex around the full ring's centre, unwrapped to increase from -π/2 to 3π/2.
  const angles: number[] = [];
  let previous = -Math.PI / 2;
  for (let k = 0; k < seam.length; k++) {
    let a = Math.atan2(seam[k].x - fullCenter.x, seam[k].z - fullCenter.z);
    while (a < previous - 1e-9) a += 2 * Math.PI;
    if (k === seam.length - 1) a = (3 * Math.PI) / 2;
    angles.push(a);
    previous = a;
  }

  // Rings bottom-up: the hem and full rings, then the blend into the seam, then the seam itself.
  const rings: Vector3[][] = [];
  for (const ring of SHORTS_LEG_RINGS) {
    const c = legCenter(ring);
    rings.push(angles.map((a) => ellipsePoint({ ...ring, dx: c.x, dz: c.z }, a, c.y, new Vector3())));
  }
  const fullRing = rings[rings.length - 1];
  for (let b = 1; b <= BLEND_RINGS; b++) {
    const s = b / (BLEND_RINGS + 1);
    rings.push(fullRing.map((q, k) => q.clone().lerp(seam[k], s)));
  }
  rings.push(seam);

  const hemY = hip.y + SHORTS_LEG_RINGS[0].y;
  const legPos: number[] = [];
  const legUv: number[] = [];
  for (const ring of rings) {
    ring.forEach((q, k) => {
      legPos.push(q.x, q.y, q.z);
      legUv.push((angles[k] + Math.PI / 2) / (2 * Math.PI), (q.y - hemY) / (split.y - hemY));
    });
  }
  const left = indexedTube(legPos, legUv, rings.length, seam.length, false);

  // Right leg: the mirror image (x and u flipped, winding reversed). Its outer arc lands
  // exactly on the waist's right half and its seam on the left leg's seam.
  const rightPos = legPos.slice();
  for (let i = 0; i < rightPos.length; i += 3) rightPos[i] = -rightPos[i];
  const rightUv = legUv.slice();
  for (let i = 0; i < rightUv.length; i += 2) rightUv[i] = 1 - rightUv[i];
  const right = indexedTube(rightPos, rightUv, rings.length, seam.length, true);

  weldNormals([waist, left, right]);
  return { waist, left, right };
}

/** Quad strips between consecutive rings (CCW from outside when angles increase towards +x at the front). */
function indexedTube(positions: number[], uvs: number[], ringCount: number, ringSize: number, flip: boolean): BufferGeometry {
  const indices: number[] = [];
  for (let i = 0; i < ringCount - 1; i++) {
    for (let j = 0; j < ringSize - 1; j++) {
      const a = i * ringSize + j;
      const b = a + 1;
      const c = a + ringSize;
      const d = c + 1;
      if (flip) indices.push(a, d, b, a, c, d);
      else indices.push(a, b, d, a, d, c);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Averages the normals of coincident vertices across parts, so UV seams and part joins shade smoothly. */
function weldNormals(geometries: readonly BufferGeometry[]): void {
  const sums = new Map<string, Vector3>();
  const key = (g: BufferGeometry, i: number): string => {
    const pos = g.getAttribute('position');
    return `${Math.round(pos.getX(i) * 1e5)},${Math.round(pos.getY(i) * 1e5)},${Math.round(pos.getZ(i) * 1e5)}`;
  };
  const n = new Vector3();
  for (const g of geometries) {
    const normal = g.getAttribute('normal');
    for (let i = 0; i < normal.count; i++) {
      const k = key(g, i);
      const sum = sums.get(k) ?? sums.set(k, new Vector3()).get(k)!;
      sum.add(n.fromBufferAttribute(normal, i));
    }
  }
  for (const g of geometries) {
    const normal = g.getAttribute('normal');
    for (let i = 0; i < normal.count; i++) {
      const sum = sums.get(key(g, i));
      if (!sum) continue;
      n.copy(sum).normalize();
      normal.setXYZ(i, n.x, n.y, n.z);
    }
  }
}
