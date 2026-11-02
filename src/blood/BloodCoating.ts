import { Color, type MeshStandardMaterial, Vector3, Vector4 } from 'three';

const MAX_BLOBS = 16;

interface Blob {
  readonly position: Vector3;
  radius: number;
  /** 0..1 how much blood. */
  amount: number;
  /** 1 fresh .. 0 dry. */
  wetness: number;
}

/**
 * Blood carried on a fist or glove (Section 7.5). Stored as a handful of blobs
 * in the mesh's local space and rendered in the fragment shader — no texture
 * needed, constant cost. Wet blood is glossy and can be passed on to the
 * opponent's skin by the next punch.
 */
export class BloodCoating {
  private readonly blobs: Blob[] = [];
  private readonly positions = Array.from({ length: MAX_BLOBS }, () => new Vector4());
  private readonly data = Array.from({ length: MAX_BLOBS }, () => new Vector4());
  private readonly uniforms = {
    uCoatPos: { value: this.positions },
    uCoatData: { value: this.data },
    uCoatCount: { value: 0 },
    uCoatTint: { value: new Color(0.32, 0.015, 0.012) },
  };

  /** Wet blood available to transfer (sum of amount × wetness). */
  get load(): number {
    let sum = 0;
    for (const b of this.blobs) sum += b.amount * b.wetness;
    return sum;
  }

  /** Blood colour (linear), e.g. for the green-blood option. */
  setTint(color: Color): void {
    this.uniforms.uCoatTint.value.copy(color);
  }

  /** Adds blood at a local-space point; nearby blobs merge, the oldest is recycled. */
  add(local: Vector3, radius: number, amount: number): void {
    for (const b of this.blobs) {
      if (b.position.distanceTo(local) < b.radius * 0.6) {
        b.amount = Math.min(1, b.amount + amount);
        b.radius = Math.min(0.05, Math.max(b.radius, radius) * 1.05);
        b.wetness = 1;
        this.sync();
        return;
      }
    }
    if (this.blobs.length >= MAX_BLOBS) this.blobs.shift();
    this.blobs.push({ position: local.clone(), radius, amount: Math.min(1, amount), wetness: 1 });
    this.sync();
  }

  /** Removes some wet blood (it was printed onto something). Returns the amount taken. */
  take(fraction: number): number {
    let taken = 0;
    for (const b of this.blobs) {
      const t = b.amount * b.wetness * fraction;
      b.amount -= t * 0.5; // the stain stays, but thinner
      taken += t;
    }
    this.sync();
    return taken;
  }

  /** Drying over time. */
  update(dt: number, dryingSpeed: number): void {
    if (this.blobs.length === 0) return;
    for (const b of this.blobs) b.wetness = Math.max(0, b.wetness - (dt * dryingSpeed) / 90);
    this.sync();
  }

  clear(): void {
    this.blobs.length = 0;
    this.sync();
  }

  /** Injects the coating into a material (local-space blobs, so the mesh must not be skinned). */
  attach(material: MeshStandardMaterial): void {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vCoatPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCoatPos = position;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vCoatPos;
uniform vec4 uCoatPos[${MAX_BLOBS}];
uniform vec4 uCoatData[${MAX_BLOBS}];
uniform int uCoatCount;
uniform vec3 uCoatTint;
float coatBlood = 0.0;
float coatWet = 0.0;`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
for (int i = 0; i < ${MAX_BLOBS}; i++) {
  if (i >= uCoatCount) break;
  vec4 p = uCoatPos[i];
  float d = distance(vCoatPos, p.xyz);
  // Irregular edge: jitter the radius with a cheap positional hash.
  float n = fract(sin(dot(floor(vCoatPos * 300.0), vec3(12.9898, 78.233, 45.164))) * 43758.5453);
  float w = 1.0 - smoothstep(p.w * (0.35 + 0.25 * n), p.w, d);
  coatBlood = max(coatBlood, w * uCoatData[i].x);
  coatWet = max(coatWet, w * uCoatData[i].x * uCoatData[i].y);
}
diffuseColor.rgb = mix(diffuseColor.rgb, uCoatTint * mix(0.45, 1.0, coatWet), clamp(coatBlood * 1.2, 0.0, 0.95));`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.16, clamp(coatWet * 1.5, 0.0, 1.0));`,
        );
    };
    material.customProgramCacheKey = () => 'blood-coating';
  }

  private sync(): void {
    const n = this.blobs.length;
    for (let i = 0; i < n; i++) {
      const b = this.blobs[i];
      this.positions[i].set(b.position.x, b.position.y, b.position.z, b.radius);
      this.data[i].set(b.amount, b.wetness, 0, 0);
    }
    this.uniforms.uCoatCount.value = n;
  }
}
