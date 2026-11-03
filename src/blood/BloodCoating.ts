import { Color, type MeshStandardMaterial, Vector3, Vector4 } from 'three';

const MAX_BLOBS = 32;

interface Blob {
  readonly position: Vector3;
  radius: number;
  /** 0..1 how much blood (film thickness). */
  amount: number;
  /** 1 fresh .. 0 dry. */
  wetness: number;
  /** Smear direction (unit, local space) and how far the mark is drawn out along it (1 = round). */
  readonly direction: Vector3;
  stretch: number;
  /** Per-mark noise offset so no two marks share a shape. */
  readonly seed: number;
}

export interface BloodMark {
  /** Smear direction in the coated mesh's local space (omit for a round mark). */
  readonly direction?: Vector3;
  /** Length / width of the mark. */
  readonly stretch?: number;
}

/**
 * Blood carried on a fist, a glove or the opponent's gloves (Section 7.5).
 * Stored as a handful of marks in the mesh's local space (bind space for a
 * skinned mesh) and rendered in the fragment shader — no texture, constant
 * cost. Each mark is an irregular, noise-edged smear or drop: thick in the
 * middle, a thin translucent stain at the edges, glossy while wet, darkening
 * to a matte brown crust as it dries. Wet blood can be passed on by the next punch.
 */
export class BloodCoating {
  private readonly blobs: Blob[] = [];
  private readonly positions = Array.from({ length: MAX_BLOBS }, () => new Vector4());
  private readonly data = Array.from({ length: MAX_BLOBS }, () => new Vector4());
  private readonly directions = Array.from({ length: MAX_BLOBS }, () => new Vector4());
  private readonly uniforms = {
    uCoatPos: { value: this.positions },
    uCoatData: { value: this.data },
    uCoatDir: { value: this.directions },
    uCoatCount: { value: 0 },
    uCoatTint: { value: new Color(0.32, 0.015, 0.012) },
  };

  /**
   * @param noiseScale noise frequency in local units per metre (bind spaces that
   *                   aren't in metres pass their scale so the edges look the same)
   */
  constructor(private readonly noiseScale = 1) {}

  /** Wet blood available to transfer (amount × wetness, weighted by mark size so specks count little). */
  get load(): number {
    let sum = 0;
    for (const b of this.blobs) sum += b.amount * b.wetness * Math.min(1, b.radius / 0.015);
    return sum;
  }

  get empty(): boolean {
    return this.blobs.length === 0;
  }

  /** Blood colour (linear), e.g. for the green-blood option. */
  setTint(color: Color): void {
    this.uniforms.uCoatTint.value.copy(color);
  }

  /** Adds blood at a local-space point; overlapping marks build up, the oldest is recycled. */
  add(local: Vector3, radius: number, amount: number, mark: BloodMark = {}): void {
    for (const b of this.blobs) {
      if (b.position.distanceTo(local) < b.radius * 0.5) {
        b.amount = Math.min(1, b.amount + amount * 0.7);
        b.radius = Math.min(0.05, Math.max(b.radius, radius) * 1.04);
        b.wetness = 1;
        this.sync();
        return;
      }
    }
    if (this.blobs.length >= MAX_BLOBS) this.blobs.shift();
    const direction = mark.direction ? mark.direction.clone().normalize() : new Vector3(1, 0, 0);
    this.blobs.push({
      position: local.clone(),
      radius,
      amount: Math.min(1, amount),
      wetness: 1,
      direction,
      stretch: mark.direction ? Math.max(1, mark.stretch ?? 1.8) : 1,
      seed: Math.random() * 100,
    });
    this.sync();
  }

  /**
   * A smear plus a scatter of fine specks around it (blood picked up from a
   * bleeding face or flicked off on impact).
   */
  splash(local: Vector3, radius: number, amount: number, direction: Vector3, specks: number): void {
    this.add(local, radius, amount, { direction, stretch: 1.5 + Math.random() * 1.2 });
    const p = new Vector3();
    for (let i = 0; i < specks; i++) {
      p.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(radius * (1 + Math.random() * 1.4));
      p.add(local);
      this.add(p, radius * (0.12 + Math.random() * 0.18), amount * (0.6 + Math.random() * 0.4));
    }
  }

  /** Removes some wet blood (it was printed onto something). Returns the amount taken. */
  take(fraction: number): number {
    let taken = 0;
    for (const b of this.blobs) {
      const t = b.amount * b.wetness * fraction;
      b.amount -= t * 0.5; // the stain stays, but thinner
      b.radius *= 1.03; // and gets smeared wider
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

  /** Injects the coating into a material (uses the unskinned `position`, i.e. local or bind space). */
  attach(material: MeshStandardMaterial): void {
    const noiseScale = this.noiseScale.toFixed(4);
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
uniform vec4 uCoatDir[${MAX_BLOBS}];
uniform int uCoatCount;
uniform vec3 uCoatTint;
float coatBlood = 0.0;
float coatWet = 0.0;
float coatHash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float coatNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(coatHash(i), coatHash(i + vec3(1, 0, 0)), f.x),
                 mix(coatHash(i + vec3(0, 1, 0)), coatHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(coatHash(i + vec3(0, 0, 1)), coatHash(i + vec3(1, 0, 1)), f.x),
                 mix(coatHash(i + vec3(0, 1, 1)), coatHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
vec3 coatP = vCoatPos * ${noiseScale};
for (int i = 0; i < ${MAX_BLOBS}; i++) {
  if (i >= uCoatCount) break;
  vec4 c = uCoatPos[i];
  vec4 data = uCoatData[i];
  vec3 dir = uCoatDir[i].xyz;
  vec3 d = vCoatPos - c.xyz;
  float along = dot(d, dir);
  vec3 across = d - dir * along;
  // Elliptical distance: smears are drawn out along their direction and taper at the tail.
  float taper = along > 0.0 ? 1.0 : 1.0 + 0.6 * (data.z - 1.0) * min(1.0, -along / (c.w * data.z));
  float e = length(vec2(along / (c.w * data.z), length(across) * taper / c.w));
  if (e > 1.6) continue;
  vec3 q = coatP + data.w;
  // Ragged edge (two octaves) and uneven film thickness.
  // (The finer octave is skewed off the lattice so it doesn't show square cells.)
  vec3 r = q + vec3(q.y, q.z, q.x) * 0.37;
  float edge = 0.65 * coatNoise(q * 180.0) + 0.35 * coatNoise(r * 430.0);
  float cover = 1.0 - smoothstep(0.55 + 0.35 * edge, 1.05 + 0.45 * edge, e);
  float film = cover * data.x * (0.7 + 0.3 * coatNoise(r * 240.0 + 7.0));
  coatBlood = 1.0 - (1.0 - coatBlood) * (1.0 - film);
  coatWet = max(coatWet, cover * data.x * data.y);
}
if (coatBlood > 0.002) {
  // Fresh blood is saturated crimson; it darkens to a brown crust as it dries.
  float wetness = clamp(coatWet / max(coatBlood, 0.001), 0.0, 1.0);
  vec3 fresh = uCoatTint;
  vec3 dried = uCoatTint * vec3(0.3, 0.55, 0.55) + vec3(0.025, 0.012, 0.008);
  // Thick pools are darker than the thin film around them.
  float pooled = smoothstep(0.35, 0.9, coatBlood);
  vec3 solid = mix(dried, fresh * mix(0.6, 0.85, wetness) * (1.05 - 0.5 * pooled), wetness);
  // Thin film at the edges reads as a translucent stain over the surface underneath.
  vec3 stain = diffuseColor.rgb * mix(vec3(0.55, 0.16, 0.13), vec3(0.75, 0.3, 0.25), 1.0 - wetness);
  float thick = smoothstep(0.15, 0.6, coatBlood);
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(stain, solid, thick), clamp(coatBlood * 1.8, 0.0, 0.96));
}`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
if (coatBlood > 0.002) {
  float wetness = clamp(coatWet / max(coatBlood, 0.001), 0.0, 1.0);
  // Wet blood is a glossy film; dried blood is matte.
  roughnessFactor = mix(roughnessFactor, mix(0.72, 0.08, wetness), clamp(coatBlood * 1.8, 0.0, 1.0));
}`,
        );
    };
    material.customProgramCacheKey = () => `blood-coating-${noiseScale}`;
  }

  private sync(): void {
    const n = this.blobs.length;
    for (let i = 0; i < n; i++) {
      const b = this.blobs[i];
      this.positions[i].set(b.position.x, b.position.y, b.position.z, b.radius);
      this.data[i].set(b.amount, b.wetness, b.stretch, b.seed);
      this.directions[i].set(b.direction.x, b.direction.y, b.direction.z, 0);
    }
    this.uniforms.uCoatCount.value = n;
  }
}
