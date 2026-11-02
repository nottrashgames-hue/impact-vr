import type { Vector2, Vector3 } from 'three';
import type { FaceZoneId } from '../damage/Zones';

export type HeadRegion = FaceZoneId | 'head';

/**
 * Region codes stored in face-region masks. A mask image encodes the code in
 * its red channel as `code * 16` (so 0 = not part of the head).
 */
export const HEAD_REGION_CODES: readonly (HeadRegion | null)[] = [
  null, // 0: not head
  'head', // 1: back / top / sides of the head, ears
  'nose',
  'eyeLeft',
  'eyeRight',
  'brow',
  'cheekLeft',
  'cheekRight',
  'mouth',
  'jaw',
];

export function headRegionCode(region: HeadRegion): number {
  return HEAD_REGION_CODES.indexOf(region);
}

export interface FaceHit {
  /** Mesh UV at the hit, if the hit came from a head-proxy raycast. */
  readonly uv: Vector2 | null;
  /** Hit point in character rest space (bind pose). */
  readonly restPoint: Vector3;
}

/** Resolves a head hit to a face region (Section 5, UV-based approach preferred). */
export interface FaceRegionLookup {
  readonly method: 'uv-mask' | 'geometric';
  classify(hit: FaceHit): HeadRegion;
}

/**
 * Classifies a point on the head by its position relative to the skull centre
 * at eye level (metres, character space: +x = character's left, +y = up).
 * `front` is 0 at the sides of the head and 1 at the front of the face.
 * Used to generate the procedural head's UV mask and as the fallback for GLB
 * heads that ship without a mask.
 */
export function classifyFacePoint(x: number, y: number, front: number): HeadRegion {
  if (front < 0.25 || y > 0.09 || y < -0.135) return 'head';
  const ax = Math.abs(x);
  const sq = (v: number): number => v * v;

  // Eye sockets (lids, socket rim and under-eye) — before the nose so the inner corners belong to the eyes.
  if (sq((x - 0.034) / 0.024) + sq((y + 0.001) / 0.018) < 1) return 'eyeLeft';
  if (sq((x + 0.034) / 0.024) + sq((y + 0.001) / 0.018) < 1) return 'eyeRight';
  if (y < 0.014 && y > -0.058 && ax < (y < -0.03 ? 0.021 : 0.013)) return 'nose';
  if (sq(x / 0.033) + sq((y + 0.075) / 0.017) < 1) return 'mouth';
  if (y >= 0.014) return front > 0.5 ? 'brow' : 'head';
  if (y > -0.062) return front > 0.35 && ax > 0.013 ? (x > 0 ? 'cheekLeft' : 'cheekRight') : 'head';
  return front > 0.3 ? 'jaw' : 'head';
}

/** Region lookup from a UV-space ID mask (procedural head, or a mask PNG shipped with a GLB). */
export class MaskFaceRegions implements FaceRegionLookup {
  readonly method = 'uv-mask' as const;

  /**
   * @param mask  one region code per texel, row 0 = top of the texture (v = 1)
   * @param size  mask resolution (square)
   */
  constructor(
    private readonly mask: Uint8Array,
    private readonly size: number,
  ) {}

  /** Builds a mask from an image whose red channel holds `code * 16`. */
  static fromImage(image: CanvasImageSource, size = 512): MaskFaceRegions {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    const mask = new Uint8Array(size * size);
    for (let i = 0; i < mask.length; i++) {
      mask[i] = Math.min(HEAD_REGION_CODES.length - 1, Math.round(data[i * 4] / 16));
    }
    return new MaskFaceRegions(mask, size);
  }

  classify(hit: FaceHit): HeadRegion {
    if (!hit.uv) return 'head';
    const u = hit.uv.x - Math.floor(hit.uv.x);
    const v = hit.uv.y - Math.floor(hit.uv.y);
    const col = Math.min(this.size - 1, Math.floor(u * this.size));
    const row = Math.min(this.size - 1, Math.floor((1 - v) * this.size));
    return HEAD_REGION_CODES[this.mask[row * this.size + col]] ?? 'head';
  }
}

/** Fallback for GLB heads without a mask: classify the bind-pose hit position. */
export class GeometricFaceRegions implements FaceRegionLookup {
  readonly method = 'geometric' as const;

  /**
   * @param headCenter skull centre at eye level in character rest space
   * @param scale      rig height / 1.8 m (classification thresholds assume 1.8 m)
   */
  constructor(
    private readonly headCenter: Vector3,
    private readonly scale: number,
  ) {}

  classify(hit: FaceHit): HeadRegion {
    const x = (hit.restPoint.x - this.headCenter.x) / this.scale;
    const y = (hit.restPoint.y - this.headCenter.y) / this.scale;
    const z = (hit.restPoint.z - this.headCenter.z) / this.scale;
    const front = Math.max(0, Math.min(1, z / Math.hypot(x, z, 1e-6)));
    return classifyFacePoint(x, y, front);
  }
}
