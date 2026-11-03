import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';

/**
 * Tiny signed-distance-field toolkit for the player's hands and gloves: shapes
 * are sculpted from primitives blended with smooth unions (so fingers flow
 * into the palm and padding into the cuff, with real creases between them)
 * and meshed once at startup.
 */

/** Distance to the surface (negative inside), in metres. */
export type Sdf = (x: number, y: number, z: number) => number;

/** Polynomial smooth minimum: union with a blend radius `k`. */
export function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Smooth subtraction of `b` from `a`. */
export function ssub(a: number, b: number, k: number): number {
  return -smin(-a, b, k);
}

/** Round cone (capsule with different end radii) from a to b. */
export function roundCone(
  x: number, y: number, z: number,
  ax: number, ay: number, az: number, ra: number,
  bx: number, by: number, bz: number, rb: number,
): number {
  const px = x - ax;
  const py = y - ay;
  const pz = z - az;
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len2 = dx * dx + dy * dy + dz * dz;
  const t = Math.min(1, Math.max(0, (px * dx + py * dy + pz * dz) / len2));
  const qx = px - dx * t;
  const qy = py - dy * t;
  const qz = pz - dz * t;
  return Math.sqrt(qx * qx + qy * qy + qz * qz) - (ra + (rb - ra) * t);
}

/** Ellipsoid (approximate distance, good near the surface). */
export function ellipsoid(x: number, y: number, z: number, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): number {
  const px = (x - cx) / rx;
  const py = (y - cy) / ry;
  const pz = (z - cz) / rz;
  const k0 = Math.sqrt(px * px + py * py + pz * pz);
  const k1 = Math.sqrt((px * px) / (rx * rx) + (py * py) / (ry * ry) + (pz * pz) / (rz * rz));
  return k1 < 1e-9 ? -Math.min(rx, ry, rz) : (k0 * (k0 - 1)) / k1;
}

/** Rounded box centred at c with half extents h and corner radius r. */
export function roundBox(
  x: number, y: number, z: number,
  cx: number, cy: number, cz: number,
  hx: number, hy: number, hz: number, r: number,
): number {
  const qx = Math.abs(x - cx) - hx + r;
  const qy = Math.abs(y - cy) - hy + r;
  const qz = Math.abs(z - cz) - hz + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const oz = Math.max(qz, 0);
  return Math.sqrt(ox * ox + oy * oy + oz * oz) + Math.min(Math.max(qx, qy, qz), 0) - r;
}

/** Elliptic cylinder along Z (axis at cx, cy) from z0 to z1, edges rounded by r. */
export function ellipticCylinderZ(
  x: number, y: number, z: number,
  cx: number, cy: number, rx: number, ry: number,
  z0: number, z1: number, r: number,
): number {
  const px = (x - cx) / rx;
  const py = (y - cy) / ry;
  const radial = (Math.sqrt(px * px + py * py) - 1) * Math.min(rx, ry) + r;
  const axial = Math.abs(z - (z0 + z1) / 2) - (z1 - z0) / 2 + r;
  return Math.min(Math.max(radial, axial), 0) + Math.hypot(Math.max(radial, 0), Math.max(axial, 0)) - r;
}

export interface SdfMeshOptions {
  readonly min: Vector3;
  readonly max: Vector3;
  /** Grid spacing (m). */
  readonly cell: number;
}

const BLOCK = 4;

/**
 * Meshes the zero level set with naive surface nets: one vertex per grid cell
 * that straddles the surface (snapped onto it), a quad across every
 * sign-changing grid edge, and normals from the field gradient. Blocks of
 * cells far from the surface are skipped, which saves most of the evaluations.
 */
export function meshSdf(sdf: Sdf, options: SdfMeshOptions): BufferGeometry {
  const { min, max, cell } = options;
  const nx = Math.ceil((max.x - min.x) / cell) + 1;
  const ny = Math.ceil((max.y - min.y) / cell) + 1;
  const nz = Math.ceil((max.z - min.z) / cell) + 1;
  const field = new Float32Array(nx * ny * nz);
  const at = (i: number, j: number, k: number): number => i + nx * (j + ny * k);

  // Sample the field, filling far-away blocks with their centre value (correct sign is all that matters there).
  const reach = 1.5 * ((BLOCK * Math.sqrt(3)) / 2 + Math.sqrt(3)) * cell;
  for (let bk = 0; bk < nz; bk += BLOCK) {
    for (let bj = 0; bj < ny; bj += BLOCK) {
      for (let bi = 0; bi < nx; bi += BLOCK) {
        const c = (BLOCK - 1) / 2;
        const centre = sdf(min.x + (bi + c) * cell, min.y + (bj + c) * cell, min.z + (bk + c) * cell);
        const far = Math.abs(centre) > reach;
        for (let k = bk; k < Math.min(bk + BLOCK, nz); k++) {
          for (let j = bj; j < Math.min(bj + BLOCK, ny); j++) {
            for (let i = bi; i < Math.min(bi + BLOCK, nx); i++) {
              field[at(i, j, k)] = far ? centre : sdf(min.x + i * cell, min.y + j * cell, min.z + k * cell);
            }
          }
        }
      }
    }
  }

  // One vertex per surface cell.
  const cellVertex = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cellAt = (i: number, j: number, k: number): number => i + (nx - 1) * (j + (ny - 1) * k);
  const positions: number[] = [];
  const corner = new Float32Array(8);
  const eps = cell * 0.25;
  // Field gradient from four taps on a tetrahedron (cheaper than central differences).
  const gradient = (x: number, y: number, z: number, out: Vector3): Vector3 => {
    const a = sdf(x + eps, y - eps, z - eps);
    const b = sdf(x - eps, y - eps, z + eps);
    const c = sdf(x - eps, y + eps, z - eps);
    const d = sdf(x + eps, y + eps, z + eps);
    return out.set(a - b - c + d, -a - b + c + d, -a + b - c + d).normalize();
  };
  const g = new Vector3();
  const AXES = [1, 2, 4];
  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          const v = field[at(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
          corner[c] = v;
          if (v < 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        // Average of the edge crossings.
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let n = 0;
        for (let c = 0; c < 8; c++) {
          for (const axis of AXES) {
            if (c & axis) continue;
            const a = corner[c];
            const b = corner[c | axis];
            if (a < 0 === b < 0) continue;
            const t = a / (a - b);
            sx += (c & 1) + (axis === 1 ? t : 0);
            sy += ((c >> 1) & 1) + (axis === 2 ? t : 0);
            sz += ((c >> 2) & 1) + (axis === 4 ? t : 0);
            n++;
          }
        }
        let x = min.x + (i + sx / n) * cell;
        let y = min.y + (j + sy / n) * cell;
        let z = min.z + (k + sz / n) * cell;
        // Snap onto the surface: one Newton step along the cell's own gradient, staying near the cell.
        const d = sdf(x, y, z);
        g.set(
          corner[1] - corner[0] + corner[3] - corner[2] + corner[5] - corner[4] + corner[7] - corner[6],
          corner[2] - corner[0] + corner[3] - corner[1] + corner[6] - corner[4] + corner[7] - corner[5],
          corner[4] - corner[0] + corner[5] - corner[1] + corner[6] - corner[2] + corner[7] - corner[3],
        ).normalize();
        const step = Math.max(-cell, Math.min(cell, d));
        x -= g.x * step;
        y -= g.y * step;
        z -= g.z * step;
        cellVertex[cellAt(i, j, k)] = positions.length / 3;
        positions.push(x, y, z);
      }
    }
  }

  // Quads across sign-changing edges; (A, B, C) cycles through (x, y, z) so B × C = A.
  const indices: number[] = [];
  const dims = [nx, ny, nz];
  const fieldStride = [1, nx, nx * ny];
  const cellStride = [1, nx - 1, (nx - 1) * (ny - 1)];
  const p = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const bAxis = (axis + 1) % 3;
    const cAxis = (axis + 2) % 3;
    const next = fieldStride[axis];
    const sb = cellStride[bAxis];
    const sc = cellStride[cAxis];
    for (p[2] = 0; p[2] < nz; p[2]++) {
      for (p[1] = 0; p[1] < ny; p[1]++) {
        for (p[0] = 0; p[0] < nx; p[0]++) {
          if (p[axis] >= dims[axis] - 1 || p[bAxis] === 0 || p[cAxis] === 0) continue;
          if (p[bAxis] >= dims[bAxis] - 1 || p[cAxis] >= dims[cAxis] - 1) continue;
          const f = at(p[0], p[1], p[2]);
          const a = field[f];
          const b = field[f + next];
          if (a < 0 === b < 0) continue;
          const c = cellAt(p[0], p[1], p[2]);
          const c0 = cellVertex[c - sb - sc];
          const c1 = cellVertex[c - sc];
          const c2 = cellVertex[c];
          const c3 = cellVertex[c - sb];
          if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) continue;
          // Inside at the low end: the surface faces +A, and c0..c3 run counter-clockwise seen from +A.
          if (a < 0) indices.push(c0, c1, c2, c0, c2, c3);
          else indices.push(c0, c2, c1, c0, c3, c2);
        }
      }
    }
  }

  const normals = new Float32Array(positions.length);
  for (let v = 0; v < positions.length; v += 3) {
    gradient(positions[v], positions[v + 1], positions[v + 2], g);
    normals[v] = g.x;
    normals[v + 1] = g.y;
    normals[v + 2] = g.z;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Ambient occlusion per vertex from the field (Quílez's five-tap estimate):
 * how much the surface around a vertex is crowded by other surfaces. Creases
 * between fingers and under the thumb come out darker. Returns 0 (occluded)..1.
 */
export function bakeOcclusion(sdf: Sdf, geometry: BufferGeometry, scale: number): Float32Array {
  const pos = geometry.getAttribute('position');
  const nor = geometry.getAttribute('normal');
  const ao = new Float32Array(pos.count);
  for (let v = 0; v < pos.count; v++) {
    const x = pos.getX(v);
    const y = pos.getY(v);
    const z = pos.getZ(v);
    const nx = nor.getX(v);
    const ny = nor.getY(v);
    const nz = nor.getZ(v);
    let occlusion = 0;
    let weight = 1;
    for (let s = 1; s <= 5; s++) {
      const h = scale * s;
      occlusion += weight * Math.max(0, h - sdf(x + nx * h, y + ny * h, z + nz * h));
      weight *= 0.6;
    }
    ao[v] = Math.max(0, Math.min(1, 1 - (occlusion / scale) * 0.55));
  }
  return ao;
}

/** Mirrors a geometry across x = 0 (positions and normals) and fixes the winding. */
export function mirrorX(geometry: BufferGeometry): BufferGeometry {
  const out = geometry.clone();
  out.scale(-1, 1, 1);
  const index = out.index;
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      const b = index.getX(i + 1);
      index.setX(i + 1, index.getX(i + 2));
      index.setX(i + 2, b);
    }
  }
  return out;
}
