import {
  BufferGeometry,
  Float32BufferAttribute,
  Matrix4,
  Quaternion,
  Uint16BufferAttribute,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** A rectangle in texture (UV) space. */
export interface AtlasRect {
  readonly u0: number;
  readonly v0: number;
  readonly w: number;
  readonly h: number;
}

export interface LoftRing {
  /** Height of the ring along the loft axis (local +Y). Rings must be ascending. */
  readonly y: number;
  /** Ellipse half-extents (x = sideways, z = front/back). */
  readonly rx: number;
  readonly rz: number;
  /** Ellipse centre offset. */
  readonly dx?: number;
  readonly dz?: number;
}

export interface LoftOptions {
  readonly segments: number;
  /** Close the bottom / top with a fan to an apex pushed out by this distance (omit for open ends). */
  readonly capBottom?: number;
  readonly capTop?: number;
  /** Extra outward displacement (metres) per vertex; `angle` 0 = front (+Z), +π/2 = +X side. */
  readonly displace?: (angle: number, y: number, x: number, z: number) => number;
}

/**
 * Tube through a list of elliptical rings along local +Y, the workhorse for the
 * procedural torso, neck, limbs and shorts. UV: u around (front centre = 0.5,
 * seam at the back), v along the rings (0 = first ring).
 */
export function loftGeometry(rings: readonly LoftRing[], options: LoftOptions): BufferGeometry {
  const segs = options.segments;
  const ringCount = rings.length;
  const positions: number[] = [];
  const uvs: number[] = [];

  for (let i = 0; i < ringCount; i++) {
    const r = rings[i];
    for (let j = 0; j <= segs; j++) {
      const a = -Math.PI + (2 * Math.PI * j) / segs;
      const sa = Math.sin(a);
      const ca = Math.cos(a);
      let x = r.rx * sa;
      let z = r.rz * ca;
      if (options.displace) {
        // Outward ellipse normal.
        let nx = sa / r.rx;
        let nz = ca / r.rz;
        const len = Math.hypot(nx, nz);
        nx /= len;
        nz /= len;
        const d = options.displace(a, r.y, x + (r.dx ?? 0), z + (r.dz ?? 0));
        x += nx * d;
        z += nz * d;
      }
      positions.push(x + (r.dx ?? 0), r.y, z + (r.dz ?? 0));
      uvs.push(j / segs, ringCount > 1 ? i / (ringCount - 1) : 0);
    }
  }

  const indices: number[] = [];
  for (let i = 0; i < ringCount - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * (segs + 1) + j;
      const b = a + 1;
      const c = a + segs + 1;
      const d = c + 1;
      // Same convention as the head: +angle runs towards +x, rings run up => CCW from outside.
      indices.push(a, b, d, a, d, c);
    }
  }

  const addCap = (ring: number, offset: number, top: boolean): void => {
    const r = rings[ring];
    const apex = positions.length / 3;
    positions.push(r.dx ?? 0, r.y + (top ? offset : -offset), r.dz ?? 0);
    uvs.push(0.5, top ? 1 : 0);
    const base = ring * (segs + 1);
    for (let j = 0; j < segs; j++) {
      if (top) indices.push(base + j, base + j + 1, apex);
      else indices.push(apex, base + j + 1, base + j);
    }
  };
  if (options.capBottom !== undefined) addCap(0, options.capBottom, false);
  if (options.capTop !== undefined) addCap(ringCount - 1, options.capTop, true);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // Weld the seam normals (first and last column share positions).
  const n = geometry.getAttribute('normal');
  const v0 = new Vector3();
  const v1 = new Vector3();
  for (let i = 0; i < ringCount; i++) {
    const first = i * (segs + 1);
    const last = first + segs;
    v0.fromBufferAttribute(n, first).add(v1.fromBufferAttribute(n, last)).normalize();
    n.setXYZ(first, v0.x, v0.y, v0.z);
    n.setXYZ(last, v0.x, v0.y, v0.z);
  }
  return geometry;
}

/**
 * Places a limb authored along local -Y (ring y = -distance from the proximal
 * joint, origin at that joint) so that it runs from `proximal` to `distal`.
 */
export function placeLimb(geometry: BufferGeometry, proximal: Vector3, distal: Vector3): BufferGeometry {
  const up = new Vector3().subVectors(proximal, distal).normalize(); // local +Y points back up the limb
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), up);
  geometry.applyMatrix4(new Matrix4().compose(proximal, q, new Vector3(1, 1, 1)));
  return geometry;
}

/** Up to two bone influences: [boneA, boneB, weightOfB]. */
export type Influence = readonly [number, number, number];
export type InfluenceFn = (p: Vector3, vertexIndex: number) => Influence;

/** Skinning helper: blend between two bones across a joint along an axis. */
export function blendAcross(
  boneA: number,
  boneB: number,
  joint: Vector3,
  axis: Vector3,
  halfWidth: number,
): InfluenceFn {
  const d = new Vector3();
  return (p) => {
    const t = d.subVectors(p, joint).dot(axis);
    const w = Math.min(1, Math.max(0, (t + halfWidth) / (2 * halfWidth)));
    const s = w * w * (3 - 2 * w);
    return [boneA, boneB, s];
  };
}

/** Skinning helper: blend along a chain of joints by height (torso, neck). */
export function blendByHeight(bones: readonly number[], joints: readonly number[], halfWidth: number): InfluenceFn {
  return (p) => {
    // joints[k] is where bones[k] meets bones[k + 1].
    for (let k = 0; k < joints.length; k++) {
      if (p.y < joints[k] + halfWidth) {
        const w = Math.min(1, Math.max(0, (p.y - (joints[k] - halfWidth)) / (2 * halfWidth)));
        const s = w * w * (3 - 2 * w);
        return [bones[k], bones[k + 1], s];
      }
    }
    return [bones[bones.length - 1], bones[bones.length - 1], 0];
  };
}

export function rigid(bone: number): InfluenceFn {
  return () => [bone, bone, 0];
}

/** Collects skinned parts and merges them into one geometry with skinIndex/skinWeight. */
export class SkinnedGeometryBuilder {
  private readonly parts: BufferGeometry[] = [];

  /**
   * @param geometry geometry with position/normal/uv, already in character rest space
   * @param influence bone influences per vertex
   * @param atlas UV rectangle the part's 0..1 UVs are remapped into
   */
  add(geometry: BufferGeometry, influence: InfluenceFn, atlas?: AtlasRect): void {
    const pos = geometry.getAttribute('position');
    const count = pos.count;
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    const p = new Vector3();
    for (let i = 0; i < count; i++) {
      p.fromBufferAttribute(pos, i);
      const [a, b, wb] = influence(p, i);
      skinIndex[i * 4] = a;
      skinIndex[i * 4 + 1] = b;
      skinWeight[i * 4] = 1 - wb;
      skinWeight[i * 4 + 1] = wb;
    }
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4));

    if (atlas) {
      const uv = geometry.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, atlas.u0 + uv.getX(i) * atlas.w, atlas.v0 + uv.getY(i) * atlas.h);
      }
    }
    // mergeGeometries needs all parts indexed (or none): give non-indexed primitives a trivial index.
    if (!geometry.index) geometry.setIndex(Array.from({ length: count }, (_, i) => i));
    this.parts.push(geometry);
  }

  build(): BufferGeometry {
    const merged = mergeGeometries(this.parts, false);
    if (!merged) throw new Error('SkinnedGeometryBuilder: incompatible parts');
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    return merged;
  }
}
