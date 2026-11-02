import {
  AddEquation,
  CanvasTexture,
  type Color,
  CustomBlending,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  Mesh,
  type MeshStandardMaterial,
  OneFactor,
  OrthographicCamera,
  PlaneGeometry,
  ReverseSubtractEquation,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector4,
  type Vector3,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { createRng } from '../audio/dsp';
import { RING } from '../config';
import { debugStats } from '../debug/DebugStats';
import { renderOffscreen } from '../skin/SurfacePainter';

const MAX_SPLATS = 128;
const ATLAS_COLS = 4;
const ATLAS_ROWS = 2;
/** Seconds for fresh floor blood to dry at drying speed 1. */
const DRY_TIME = 150;

/** Splat sprite variants in the atlas. */
const enumVariant = {
  round: 0,
  roundRim: 1,
  satellites: 2,
  elongated: 3,
  tail: 4,
  crown: 5,
  splash: 6,
  smear: 7,
} as const;

const _uv = new Vector2();

/**
 * Blood on the ring canvas (Section 7.3). One accumulation texture covers the
 * whole canvas: R = amount (thickness: repeated drips pool), G = wetness (dries
 * over time). Splats are drawn into it as instanced sprites — one draw call per
 * frame however many land — so the cost never grows with how much blood is
 * spilled. The canvas shader blends it over the floor: fresh blood saturated
 * and glossy, pools darker, dried blood brown and matte.
 */
export class FloorBlood {
  readonly target: WebGLRenderTarget;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry: InstancedBufferGeometry;
  private readonly center: InstancedBufferAttribute;
  private readonly params: InstancedBufferAttribute;
  private readonly extra: InstancedBufferAttribute;
  private queued = 0;
  private readonly ageScene = new Scene();
  private readonly ageMaterial: ShaderMaterial;
  private ageTimer = 0;
  private wetDebt = 0;
  private readonly uniforms;
  private readonly rng = createRng(4242);

  constructor(
    size: number,
    floorMaterial: MeshStandardMaterial,
    private readonly worldToUV: (x: number, z: number, out: Vector2) => boolean,
  ) {
    this.target = new WebGLRenderTarget(size, size, {
      type: UnsignedByteType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
    });

    // Instanced unit quads, one per splat this frame.
    const quad = new PlaneGeometry(1, 1);
    this.geometry = new InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.setAttribute('uv', quad.getAttribute('uv'));
    this.center = new InstancedBufferAttribute(new Float32Array(MAX_SPLATS * 2), 2);
    this.params = new InstancedBufferAttribute(new Float32Array(MAX_SPLATS * 4), 4); // size, elongation, rotation, variant
    this.extra = new InstancedBufferAttribute(new Float32Array(MAX_SPLATS * 2), 2); // amount, wet
    this.geometry.setAttribute('aCenter', this.center);
    this.geometry.setAttribute('aParams', this.params);
    this.geometry.setAttribute('aExtra', this.extra);
    this.geometry.instanceCount = 0;

    const splatMaterial = new ShaderMaterial({
      uniforms: { uAtlas: { value: createSplatAtlas() } },
      vertexShader: /* glsl */ `
        attribute vec2 aCenter;
        attribute vec4 aParams;
        attribute vec2 aExtra;
        varying vec2 vUv;
        varying vec2 vExtra;
        void main() {
          float c = cos(aParams.z);
          float s = sin(aParams.z);
          vec2 local = position.xy * vec2(aParams.x * aParams.y, aParams.x);
          vec2 uvPos = aCenter + vec2(c * local.x - s * local.y, s * local.x + c * local.y);
          float variant = aParams.w;
          // Canvas textures are flipped: atlas row 0 sits at the top (high v).
          vec2 cell = vec2(mod(variant, ${ATLAS_COLS}.0), ${ATLAS_ROWS - 1}.0 - floor(variant / ${ATLAS_COLS}.0));
          vUv = (cell + uv) / vec2(${ATLAS_COLS}.0, ${ATLAS_ROWS}.0);
          vExtra = aExtra;
          gl_Position = vec4(uvPos * 2.0 - 1.0, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uAtlas;
        varying vec2 vUv;
        varying vec2 vExtra;
        void main() {
          float a = texture2D(uAtlas, vUv).r;
          gl_FragColor = vec4(a * vExtra.x, a * vExtra.y, 0.0, 0.0);
        }`,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      depthTest: false,
      depthWrite: false,
    });
    const splats = new Mesh(this.geometry, splatMaterial);
    splats.frustumCulled = false;
    this.scene.add(splats);

    this.ageMaterial = new ShaderMaterial({
      uniforms: { uSub: { value: new Vector4() } },
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform vec4 uSub; void main() { gl_FragColor = uSub; }',
      blending: CustomBlending,
      blendEquation: ReverseSubtractEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      depthTest: false,
      depthWrite: false,
    });
    const full = new Mesh(new PlaneGeometry(2, 2), this.ageMaterial);
    full.frustumCulled = false;
    this.ageScene.add(full);

    this.uniforms = {
      uFloorBlood: { value: this.target.texture },
      uFloorBloodOn: { value: 1 },
      uFloorBloodTint: { value: floorMaterial.color.clone().setRGB(0.3, 0.012, 0.01) },
    };
    this.inject(floorMaterial);
  }

  setTint(color: Color, enabled: boolean): void {
    this.uniforms.uFloorBloodTint.value.copy(color);
    this.uniforms.uFloorBloodOn.value = enabled ? 1 : 0;
  }

  /**
   * A drop landed (Section 7.3). Shape from impact speed and angle: slow drips
   * from above make small round drops with a darker rim; fast or angled hits
   * elongate with satellites and a tail along the direction of travel.
   */
  splat(x: number, z: number, velocity: Vector3, radius: number, amount = 1): void {
    if (this.queued >= MAX_SPLATS || !this.worldToUV(x, z, _uv)) return;
    const speed = velocity.length();
    const horizontal = Math.hypot(velocity.x, velocity.z);
    const slant = horizontal / Math.max(Math.abs(velocity.y), 0.5);
    const r = this.rng;
    let variant: number;
    if (speed < 2.5 && slant < 0.35) variant = r() < 0.5 ? enumVariant.round : enumVariant.roundRim;
    else if (slant < 0.5) variant = r() < 0.6 ? enumVariant.satellites : enumVariant.crown;
    else if (speed > 4.5) variant = r() < 0.5 ? enumVariant.tail : enumVariant.splash;
    else variant = r() < 0.5 ? enumVariant.elongated : enumVariant.tail;

    const diameter = (radius * (7 + speed * 1.4) * (0.85 + r() * 0.3)) / RING.floorSize; // in UV units
    const elongation = 1 + Math.min(2.2, slant * 0.9);
    // Rotate the sprite's +x (tail) along the travel direction; floor v runs along -z.
    const rotation = horizontal > 0.05 ? Math.atan2(-velocity.z, velocity.x) : r() * Math.PI * 2;

    const i = this.queued++;
    this.center.setXY(i, _uv.x, _uv.y);
    this.params.setXYZW(i, diameter, elongation, rotation, variant);
    this.extra.setXY(i, Math.min(1, 0.16 * amount * (0.8 + r() * 0.4)), 1);
  }

  /** Draws this frame's splats and runs the low-rate drying pass. */
  update(renderer: WebGLRenderer, dt: number, dryingSpeed: number): void {
    if (this.queued > 0) {
      this.geometry.instanceCount = this.queued;
      this.center.needsUpdate = true;
      this.params.needsUpdate = true;
      this.extra.needsUpdate = true;
      renderOffscreen(renderer, [this.target], () => renderer.render(this.scene, this.camera));
      debugStats.decals += this.queued;
      this.queued = 0;
    }

    this.ageTimer += dt;
    if (this.ageTimer < 0.5) return;
    this.wetDebt += (this.ageTimer * dryingSpeed) / DRY_TIME;
    this.ageTimer = 0;
    if (this.wetDebt < 2 / 255) return;
    (this.ageMaterial.uniforms.uSub.value as Vector4).set(0, this.wetDebt, 0, 0);
    this.wetDebt = 0;
    renderOffscreen(renderer, [this.target], () => renderer.render(this.ageScene, this.camera));
  }

  /** Clean Floor. */
  clear(renderer: WebGLRenderer): void {
    this.queued = 0;
    renderOffscreen(renderer, [this.target], () => renderer.clear(true, false, false));
  }

  resize(size: number): void {
    this.target.setSize(size, size);
  }

  private inject(material: MeshStandardMaterial): void {
    const previous = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      previous.call(material, shader, renderer);
      Object.assign(shader.uniforms, this.uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform sampler2D uFloorBlood;
uniform float uFloorBloodOn;
uniform vec3 uFloorBloodTint;
float floorBloodCover = 0.0;
float floorBloodWet = 0.0;
float floorBloodPool = 0.0;`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
vec4 fb = texture2D(uFloorBlood, vMapUv);
floorBloodCover = smoothstep(0.015, 0.09, fb.r) * uFloorBloodOn;
floorBloodPool = smoothstep(0.25, 0.85, fb.r);
floorBloodWet = fb.g;
vec3 freshBlood = uFloorBloodTint * mix(1.15, 0.6, floorBloodPool);
vec3 driedBlood = mix(uFloorBloodTint * 0.45, vec3(0.085, 0.03, 0.02) * step(0.01, uFloorBloodTint.r), 0.6);
diffuseColor.rgb = mix(diffuseColor.rgb, mix(driedBlood, freshBlood, floorBloodWet), floorBloodCover * 0.96);`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, mix(0.2, 0.05, floorBloodPool), floorBloodCover * floorBloodWet);`,
        );
    };
    material.customProgramCacheKey = () => 'floor-blood';
    material.needsUpdate = true;
  }
}

/**
 * Procedural splat sprites (8 variants, ≥ 6 required): round drops (one with a
 * darker rim), drops with satellites, elongated splats with tails, a crown and
 * an irregular splash, plus a smear. White = blood thickness.
 */
function createSplatAtlas(): CanvasTexture {
  const cell = 256;
  const canvas = document.createElement('canvas');
  canvas.width = cell * ATLAS_COLS;
  canvas.height = cell * ATLAS_ROWS;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const rng = createRng(77);

  const blob = (cx: number, cy: number, r: number, wobble: number, rim: boolean, intensity = 1): void => {
    ctx.beginPath();
    const steps = 40;
    for (let s = 0; s <= steps; s++) {
      const a = (s / steps) * Math.PI * 2;
      const rr = r * (1 + (rng() - 0.5) * wobble);
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    const v = Math.round(255 * intensity);
    if (rim) {
      g.addColorStop(0, `rgb(${Math.round(v * 0.55)},0,0)`);
      g.addColorStop(0.75, `rgb(${Math.round(v * 0.7)},0,0)`);
      g.addColorStop(0.95, `rgb(${v},0,0)`);
      g.addColorStop(1, `rgb(${Math.round(v * 0.6)},0,0)`);
    } else {
      g.addColorStop(0, `rgb(${v},0,0)`);
      g.addColorStop(0.85, `rgb(${Math.round(v * 0.85)},0,0)`);
      g.addColorStop(1, `rgb(${Math.round(v * 0.3)},0,0)`);
    }
    ctx.fillStyle = g;
    ctx.fill();
  };
  const satellites = (cx: number, cy: number, count: number, minR: number, maxR: number, dirX: number, spread: number): void => {
    for (let i = 0; i < count; i++) {
      const a = (rng() - 0.5) * spread + Math.atan2(0, dirX);
      const d = minR + rng() * (maxR - minR);
      blob(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 3 + rng() * 8, 0.3, false, 0.8);
    }
  };

  const cellOrigin = (i: number): [number, number] => [(i % ATLAS_COLS) * cell + cell / 2, Math.floor(i / ATLAS_COLS) * cell + cell / 2];
  ctx.save();
  // 0 round, 1 round with darker rim
  blob(...cellOrigin(0), 70, 0.12, false);
  blob(...cellOrigin(1), 72, 0.08, true);
  // 2 drop with satellites all round, 5 crown (spiky ring of satellites)
  {
    const [cx, cy] = cellOrigin(2);
    blob(cx, cy, 58, 0.18, true);
    satellites(cx, cy, 9, 70, 110, 1, Math.PI * 2);
  }
  {
    const [cx, cy] = cellOrigin(5);
    blob(cx, cy, 52, 0.4, false);
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + rng() * 0.3;
      blob(cx + Math.cos(a) * 68, cy + Math.sin(a) * 68, 6 + rng() * 6, 0.2, false, 0.85);
    }
  }
  // 3 elongated (stretched blob), 4 tail with satellites ahead (direction +x)
  for (const [i, tail] of [
    [3, false],
    [4, true],
  ] as const) {
    const [cx, cy] = cellOrigin(i);
    ctx.save();
    ctx.translate(cx - 20, cy);
    ctx.scale(1.6, 0.85);
    blob(0, 0, 55, 0.15, true);
    ctx.restore();
    if (tail) {
      for (let k = 0; k < 6; k++) blob(cx + 60 + k * 9, cy + (rng() - 0.5) * 8, 12 - k * 1.6, 0.2, false, 0.9);
      satellites(cx + 70, cy, 6, 20, 50, 1, 0.9);
    }
  }
  // 6 irregular splash
  {
    const [cx, cy] = cellOrigin(6);
    for (let k = 0; k < 6; k++) blob(cx + (rng() - 0.5) * 70, cy + (rng() - 0.5) * 70, 22 + rng() * 26, 0.35, false, 0.9);
    satellites(cx, cy, 10, 70, 115, 1, Math.PI * 2);
  }
  // 7 smear: a streaky stroke
  {
    const [cx, cy] = cellOrigin(7);
    for (let k = 0; k < 18; k++) blob(cx - 90 + k * 10, cy + Math.sin(k * 0.6) * 6, 26 - Math.abs(k - 9) * 1.4, 0.25, false, 0.55 + rng() * 0.3);
  }
  ctx.restore();

  const texture = new CanvasTexture(canvas);
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  return texture;
}
