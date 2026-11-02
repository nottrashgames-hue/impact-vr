import { Color, type MeshStandardMaterial, Vector4, type WebGLRenderer } from 'three';
import type { Settings } from '../core/Settings';
import type { HumanoidRig } from '../opponent/HumanoidRig';
import { type Stamp, SurfacePainter } from './SurfacePainter';

/** Paint target indices. */
export const DAMAGE_MAP = 0;
export const BLOOD_MAP = 1;

/** Seconds for a bruise to fully develop / for fresh blood to dry, at speed 1 (compressed game time). */
const BRUISE_DEVELOP_TIME = 150;
const BLOOD_DRY_TIME = 90;
/** Healing (optional): seconds for swelling / blood to fade completely. */
const SWELL_HEAL_TIME = 300;
const BLOOD_HEAL_TIME = 420;
/** Aging runs at a low rate and only once at least this much has accumulated (8-bit textures). */
const AGE_INTERVAL = 0.5;
const MIN_STEP = 2 / 255;

/** Blood colour per setting (linear RGB). */
export const BLOOD_TINTS = {
  red: new Color(0.3, 0.012, 0.01),
  green: new Color(0.06, 0.22, 0.03),
  off: new Color(0, 0, 0),
} as const;

/**
 * The opponent's damage and blood paint (Sections 7.4 and 8): two textures in
 * the body's UV layout and the shader code that turns them into bruises,
 * swelling, cuts and blood on the skin and clothes.
 *
 * Damage map: R = bruise amount, G = bruise freshness (1 = just hit, decays to
 * 0 as the bruise develops), B = swelling, A = cuts.
 * Blood map: R = amount, G = wetness (1 = fresh, decays as it dries).
 */
export class SkinSurface {
  readonly painter: SurfacePainter;
  private readonly uniforms;
  private ageTimer = 0;
  private bruiseDebt = 0;
  private wetDebt = 0;
  private swellHealDebt = 0;
  private bloodHealDebt = 0;

  /**
   * @param metersPerUnit size of one bind-space unit in metres (1 for the procedural rig)
   */
  constructor(rig: HumanoidRig, size: number, metersPerUnit: number) {
    this.painter = new SurfacePainter(
      rig.paintSurfaces.map((s) => s.paintGeometry),
      size,
      2,
      rig.paintCullDistance,
    );
    this.uniforms = {
      uDamageMap: { value: this.painter.targets[DAMAGE_MAP].texture },
      uBloodMap: { value: this.painter.targets[BLOOD_MAP].texture },
      /** Maximum swelling displacement in bind units. */
      uSwell: { value: 0.01 / metersPerUnit },
      uBruiseOn: { value: 1 },
      uBloodOn: { value: 1 },
      uBloodTint: { value: BLOOD_TINTS.red.clone() },
      uTexel: { value: 1 / size },
    };
    for (const surface of rig.paintSurfaces) this.inject(surface.material, surface.cloth);
  }

  queue(target: typeof DAMAGE_MAP | typeof BLOOD_MAP, stamp: Stamp): void {
    this.painter.queue(target, stamp);
  }

  applySettings(settings: Readonly<Settings>, bloodScale: number): void {
    this.uniforms.uBruiseOn.value = settings.bruising ? 1 : 0;
    this.uniforms.uBloodOn.value = bloodScale > 0 ? 1 : 0;
    this.uniforms.uBloodTint.value.copy(BLOOD_TINTS[settings.bloodColor]);
  }

  /** Flushes queued paint and runs the low-rate aging pass. */
  update(renderer: WebGLRenderer, dt: number, settings: Readonly<Settings>): void {
    this.painter.flush(renderer);

    this.ageTimer += dt;
    if (this.ageTimer < AGE_INTERVAL) return;
    const step = this.ageTimer;
    this.ageTimer = 0;
    this.bruiseDebt += (step * settings.bruiseSpeed) / BRUISE_DEVELOP_TIME;
    this.wetDebt += (step * settings.dryingSpeed) / BLOOD_DRY_TIME;
    if (settings.healing) {
      this.swellHealDebt += step / SWELL_HEAL_TIME;
      this.bloodHealDebt += step / BLOOD_HEAL_TIME;
    }

    const damage = new Vector4(0, this.take('bruiseDebt'), this.take('swellHealDebt'), 0);
    if (damage.y > 0 || damage.z > 0) this.painter.age(renderer, DAMAGE_MAP, damage);
    const blood = new Vector4(this.take('bloodHealDebt'), this.take('wetDebt'), 0, 0);
    if (blood.x > 0 || blood.y > 0) this.painter.age(renderer, BLOOD_MAP, blood);
  }

  /** Erases all bruises, swelling, cuts and blood. */
  clear(renderer: WebGLRenderer): void {
    this.painter.clear(renderer);
    this.bruiseDebt = this.wetDebt = this.swellHealDebt = this.bloodHealDebt = 0;
  }

  resize(size: number): void {
    this.painter.resize(size);
    this.uniforms.uTexel.value = 1 / size;
  }

  get damageTexture() {
    return this.painter.targets[DAMAGE_MAP].texture;
  }

  get bloodTexture() {
    return this.painter.targets[BLOOD_MAP].texture;
  }

  /** Returns an accumulated aging amount once it is worth a pass (≥ 2/255), resetting it. */
  private take(key: 'bruiseDebt' | 'wetDebt' | 'swellHealDebt' | 'bloodHealDebt'): number {
    const v = this[key];
    if (v < MIN_STEP) return 0;
    this[key] = 0;
    return v;
  }

  private inject(material: MeshStandardMaterial, cloth: boolean): void {
    const previous = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
uniform sampler2D uDamageMap;
uniform float uSwell;
uniform float uBruiseOn;
varying vec2 vPaintUv;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
vPaintUv = uv;
// Swelling (Section 8.4): push the bind-pose surface out along its bind-pose
// normal, before skinning (objectNormal is already skinned at this point).
transformed += normal * texture2D(uDamageMap, uv).b * uSwell * uBruiseOn;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform sampler2D uDamageMap;
uniform sampler2D uBloodMap;
uniform float uBruiseOn;
uniform float uBloodOn;
uniform vec3 uBloodTint;
uniform float uTexel;
varying vec2 vPaintUv;
float paintBlood = 0.0;
float paintWet = 0.0;
float paintCut = 0.0;`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
${cloth ? CLOTH_FRAGMENT : SKIN_FRAGMENT}`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
${cloth ? '' : 'roughnessFactor = mix(roughnessFactor, 0.12, clamp(paintBlood * paintWet * 1.3, 0.0, 1.0));'}
roughnessFactor = mix(roughnessFactor, 0.22, paintCut);`,
        );
    };
    material.customProgramCacheKey = () => `skin-paint-${cloth ? 'cloth' : 'skin'}`;
    material.needsUpdate = true;
  }
}

/** Bruise colour progression, cuts and wet/drying blood on skin. */
const SKIN_FRAGMENT = /* glsl */ `
vec4 dmg = texture2D(uDamageMap, vPaintUv);
vec4 bld = texture2D(uBloodMap, vPaintUv);
// Bruising sits under the skin: multiply, never paint over (Section 8.2).
// Mottled with value noise so edges break up irregularly instead of reading as discs.
vec2 nUv = vPaintUv * 220.0;
vec2 nI = floor(nUv);
vec2 nF = fract(nUv);
nF = nF * nF * (3.0 - 2.0 * nF);
float h00 = fract(sin(dot(nI, vec2(127.1, 311.7))) * 43758.5453);
float h10 = fract(sin(dot(nI + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
float h01 = fract(sin(dot(nI + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
float h11 = fract(sin(dot(nI + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
float mottle = mix(mix(h00, h10, nF.x), mix(h01, h11, nF.x), nF.y);
float bruise = dmg.r * uBruiseOn * (0.7 + 0.6 * mottle);
if (bruise > 0.002) {
  float dev = clamp(1.0 - dmg.g, 0.0, 1.0); // 0 = just hit .. 1 = fully developed
  vec3 flush = vec3(1.0, 0.62, 0.6);       // red / pink flush
  vec3 redPurple = vec3(0.78, 0.42, 0.52);
  vec3 purpleBlue = vec3(0.5, 0.36, 0.62);
  vec3 deep = vec3(0.3, 0.18, 0.34);
  vec3 tint = dev < 0.33 ? mix(flush, redPurple, dev / 0.33)
            : dev < 0.66 ? mix(redPurple, purpleBlue, (dev - 0.33) / 0.33)
            : mix(purpleBlue, deep, (dev - 0.66) / 0.34);
  // Darker, near-black centre where the bruise is heaviest; soft purple-blue edges.
  tint *= mix(1.0, 0.55, smoothstep(0.55, 1.0, bruise) * dev);
  float k = smoothstep(0.0, 0.85, bruise);
  vec3 bruised = diffuseColor.rgb * tint;
  float lum = dot(bruised, vec3(0.299, 0.587, 0.114));
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(bruised, vec3(lum), 0.15), k);
}
// Fresh swelling reads as redness.
diffuseColor.rgb *= mix(vec3(1.0), vec3(1.08, 0.88, 0.88), clamp(dmg.b * 0.8, 0.0, 1.0) * dmg.g * uBruiseOn);
// Cuts: dark red lines with a wet sheen (Section 8.5).
paintCut = smoothstep(0.25, 0.7, dmg.a) * uBloodOn;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.012, 0.012), paintCut);
// Blood: fresh = saturated and glossy, dry = darker, brown and matte.
paintBlood = smoothstep(0.03, 0.4, bld.r) * uBloodOn;
paintWet = bld.g;
vec3 dried = mix(uBloodTint * 0.45, vec3(0.09, 0.03, 0.02) * step(0.01, uBloodTint.r), 0.5);
diffuseColor.rgb = mix(diffuseColor.rgb, mix(dried, uBloodTint, paintWet), paintBlood * 0.94);
`;

/** Cloth soaks blood up: wider, softer (blurred), darker stains with no gloss. */
const CLOTH_FRAGMENT = /* glsl */ `
float soak = 0.0;
for (int i = -1; i <= 1; i++) {
  for (int j = -1; j <= 1; j++) {
    soak += texture2D(uBloodMap, vPaintUv + vec2(float(i), float(j)) * uTexel * 3.0).r;
  }
}
soak /= 9.0;
paintBlood = smoothstep(0.015, 0.3, soak) * uBloodOn;
diffuseColor.rgb = mix(diffuseColor.rgb, uBloodTint * 0.35, paintBlood * 0.85);
`;
