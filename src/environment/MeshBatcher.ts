import {
  type BufferGeometry,
  Color,
  Euler,
  Float32BufferAttribute,
  type Material,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Returns a light multiplier for a world-space vertex (fake baked lighting / AO). */
export type BakeFunction = (position: Vector3, normal: Vector3) => number;

export interface PieceOptions {
  position?: readonly [number, number, number];
  rotation?: readonly [number, number, number];
  scale?: readonly [number, number, number];
  /** Per-piece colour (sRGB hex or Color) baked into vertex colours. Default white. */
  tint?: number | Color;
  /** Bake lighting into the vertex colours (default true). Off for emissive pieces. */
  bake?: boolean;
  /** UV tiling multiplier applied before `uvOffset`. */
  uvScale?: readonly [number, number];
  uvOffset?: readonly [number, number];
}

const _matrix = new Matrix4();
const _quat = new Quaternion();
const _euler = new Euler();
const _pos = new Vector3();
const _scale = new Vector3();
const _p = new Vector3();
const _n = new Vector3();
const _tint = new Color();

/**
 * Collects static geometry per material and merges it into one mesh per
 * material, so the whole gym renders in a handful of draw calls. Lighting and
 * ambient occlusion are baked into vertex colours at build time (Section 2:
 * "baked/static lighting where possible").
 */
export class MeshBatcher {
  private readonly pieces = new Map<Material, BufferGeometry[]>();

  constructor(private readonly bake: BakeFunction) {}

  /** Adds a piece. The geometry is consumed (transformed in place / disposed). */
  add(material: Material, geometry: BufferGeometry, options: PieceOptions = {}): void {
    // mergeGeometries needs a consistent layout: make everything non-indexed.
    const geo = geometry.index ? geometry.toNonIndexed() : geometry;
    if (geo !== geometry) geometry.dispose();

    const uv = geo.getAttribute('uv');
    if (uv && (options.uvScale || options.uvOffset)) {
      const [su, sv] = options.uvScale ?? [1, 1];
      const [ou, ov] = options.uvOffset ?? [0, 0];
      for (let i = 0; i < uv.count; i++) {
        uv.setXY(i, uv.getX(i) * su + ou, uv.getY(i) * sv + ov);
      }
    }

    const [px, py, pz] = options.position ?? [0, 0, 0];
    const [rx, ry, rz] = options.rotation ?? [0, 0, 0];
    const [sx, sy, sz] = options.scale ?? [1, 1, 1];
    _quat.setFromEuler(_euler.set(rx, ry, rz));
    _matrix.compose(_pos.set(px, py, pz), _quat, _scale.set(sx, sy, sz));
    geo.applyMatrix4(_matrix);

    // Vertex colours = tint × baked light.
    const tint = options.tint;
    if (tint instanceof Color) _tint.copy(tint);
    else _tint.setHex(tint ?? 0xffffff);
    const doBake = options.bake ?? true;
    const pos = geo.getAttribute('position');
    const nrm = geo.getAttribute('normal');
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      let light = 1;
      if (doBake) {
        _p.fromBufferAttribute(pos, i);
        _n.fromBufferAttribute(nrm, i);
        light = this.bake(_p, _n);
      }
      colors[i * 3] = _tint.r * light;
      colors[i * 3 + 1] = _tint.g * light;
      colors[i * 3 + 2] = _tint.b * light;
    }
    geo.setAttribute('color', new Float32BufferAttribute(colors, 3));

    let list = this.pieces.get(material);
    if (!list) {
      list = [];
      this.pieces.set(material, list);
    }
    list.push(geo);
  }

  /** Merges all pieces into static meshes (one per material). */
  build(): Mesh[] {
    const meshes: Mesh[] = [];
    for (const [material, list] of this.pieces) {
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) throw new Error('MeshBatcher: incompatible geometry attributes');
      merged.computeBoundingSphere();
      const mesh = new Mesh(merged, material);
      mesh.matrixAutoUpdate = false;
      mesh.name = `static:${material.name || material.type}`;
      meshes.push(mesh);
    }
    this.pieces.clear();
    return meshes;
  }
}
