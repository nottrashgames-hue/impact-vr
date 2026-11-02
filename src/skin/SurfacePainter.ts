import {
  AddEquation,
  type BufferGeometry,
  Color,
  CustomBlending,
  DoubleSide,
  LinearFilter,
  Mesh,
  OneFactor,
  OrthographicCamera,
  PlaneGeometry,
  ReverseSubtractEquation,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';
import { debugStats } from '../debug/DebugStats';

/**
 * Brush shapes: Sphere = soft round dab; Ring = ring around the centre (a
 * black eye following the socket); Segment = capsule along a segment (cuts,
 * blood streaks).
 */
export const StampKind = { Sphere: 0, Ring: 1, Segment: 2 } as const;
export type StampKind = (typeof StampKind)[keyof typeof StampKind];

export interface Stamp {
  readonly kind: StampKind;
  /** Centre (sphere/ring) or segment start, in the painted mesh's bind space. */
  readonly a: Vector3;
  /** Segment end (segments only). */
  readonly b?: Vector3;
  /** Radius (bind-space units). For rings: the outer limit. */
  readonly radius: number;
  /** 0 = soft falloff .. 1 = hard edge. Rings: ring radius as a fraction of `radius`. */
  readonly hardness: number;
  /** Amount added to each channel (RGBA) at full brush weight. */
  readonly value: Vector4;
}

const MAX_STAMPS = 16;

const VERTEX = /* glsl */ `
uniform vec4 uA[${MAX_STAMPS}];
uniform vec4 uB[${MAX_STAMPS}];
uniform int uCount;
uniform float uCull;
varying vec3 vPos;

float segDist(vec3 p, vec3 a, vec3 b) {
  vec3 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-10), 0.0, 1.0);
  return length(p - (a + ab * t));
}

float stampDist(vec3 p, int i) {
  return int(uB[i].w) == ${StampKind.Segment} ? segDist(p, uA[i].xyz, uB[i].xyz) : distance(p, uA[i].xyz);
}

void main() {
  vPos = position;
  // Skip vertices far from every stamp: their triangles collapse off-screen, so
  // only texels near the stamps are shaded (triangles are smaller than uCull).
  float nearest = 1e9;
  for (int i = 0; i < ${MAX_STAMPS}; i++) {
    if (i >= uCount) break;
    nearest = min(nearest, stampDist(position, i) - uA[i].w);
  }
  gl_Position = nearest > uCull ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = /* glsl */ `
uniform vec4 uA[${MAX_STAMPS}];
uniform vec4 uB[${MAX_STAMPS}];
uniform vec4 uV[${MAX_STAMPS}];
uniform int uCount;
varying vec3 vPos;

float segDist(vec3 p, vec3 a, vec3 b) {
  vec3 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-10), 0.0, 1.0);
  return length(p - (a + ab * t));
}

void main() {
  vec4 sum = vec4(0.0);
  for (int i = 0; i < ${MAX_STAMPS}; i++) {
    if (i >= uCount) break;
    int kind = int(uB[i].w);
    float r = uA[i].w;
    float hard = uB[i].w - float(kind); // fractional part carries hardness
    float w;
    if (kind == ${StampKind.Segment}) {
      w = 1.0 - smoothstep(r * hard, r, segDist(vPos, uA[i].xyz, uB[i].xyz));
    } else if (kind == ${StampKind.Ring}) {
      float d = distance(vPos, uA[i].xyz);
      float ringR = r * max(hard, 0.05);
      float width = r * 0.32;
      // Heaviest below the eye and on the upper lid; fades out towards the outer limit.
      float below = vPos.y < uA[i].y ? 1.25 : 0.85;
      w = exp(-pow((d - ringR) / width, 2.0)) * below * (1.0 - smoothstep(r * 0.45, r, d));
      w += (1.0 - smoothstep(0.0, ringR, d)) * 0.35; // some colour over the lid itself
    } else {
      w = 1.0 - smoothstep(r * hard, r, distance(vPos, uA[i].xyz));
    }
    sum += uV[i] * w;
  }
  gl_FragColor = sum;
}`;

function createTarget(size: number): WebGLRenderTarget {
  return new WebGLRenderTarget(size, size, {
    type: UnsignedByteType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
  });
}

/**
 * Paints into textures laid out in a mesh's UV space using a brush defined in
 * the mesh's bind-pose 3D space (Sections 7.4, 8.1). Because the brush works
 * in 3D, strokes cross UV seams seamlessly and the same code works for any
 * rig. Stamps are queued and flushed in batches (16 per draw); an "aging" pass
 * subtracts per-channel amounts at a low rate (drying, bruise development)
 * with reverse-subtract blending, so no ping-pong texture or GPU readback is
 * ever needed.
 */
export class SurfacePainter {
  readonly targets: WebGLRenderTarget[];
  private readonly queues: Stamp[][];
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: ShaderMaterial;
  private readonly ageScene = new Scene();
  private readonly ageMaterial: ShaderMaterial;
  private readonly a = Array.from({ length: MAX_STAMPS }, () => new Vector4());
  private readonly b = Array.from({ length: MAX_STAMPS }, () => new Vector4());
  private readonly v = Array.from({ length: MAX_STAMPS }, () => new Vector4());

  /**
   * @param geometries meshes sharing one UV layout (bind-space positions + uvs)
   * @param targetCount number of RGBA textures painted through this layout
   * @param cull       distance beyond a stamp's radius at which vertices are skipped
   *                   (must exceed the longest triangle edge, in bind-space units)
   */
  constructor(geometries: readonly BufferGeometry[], size: number, targetCount: number, cull: number) {
    this.targets = Array.from({ length: targetCount }, () => createTarget(size));
    this.queues = this.targets.map(() => []);
    this.material = new ShaderMaterial({
      uniforms: {
        uA: { value: this.a },
        uB: { value: this.b },
        uV: { value: this.v },
        uCount: { value: 0 },
        uCull: { value: cull },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    for (const geometry of geometries) {
      const mesh = new Mesh(geometry, this.material);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
    }

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
    const quad = new Mesh(new PlaneGeometry(2, 2), this.ageMaterial);
    quad.frustumCulled = false;
    this.ageScene.add(quad);
  }

  get pending(): boolean {
    return this.queues.some((q) => q.length > 0);
  }

  queue(target: number, stamp: Stamp): void {
    this.queues[target].push(stamp);
  }

  /** Renders all queued stamps (call once per frame, outside the main render). */
  flush(renderer: WebGLRenderer): void {
    if (!this.pending) return;
    this.withTarget(renderer, (index) => {
      const queue = this.queues[index];
      while (queue.length > 0) {
        const batch = queue.splice(0, MAX_STAMPS);
        batch.forEach((s, i) => {
          this.a[i].set(s.a.x, s.a.y, s.a.z, s.radius);
          const b = s.b ?? s.a;
          // Kind in the integer part, hardness in the fraction (clamped below 1).
          this.b[i].set(b.x, b.y, b.z, s.kind + Math.min(0.999, Math.max(0, s.hardness)));
          this.v[i].copy(s.value);
        });
        this.material.uniforms.uCount.value = batch.length;
        renderer.render(this.scene, this.camera);
        debugStats.decals += batch.length;
      }
    });
  }

  /** Subtracts `amount` (per channel, clamped at 0) from the whole texture. */
  age(renderer: WebGLRenderer, target: number, amount: Vector4): void {
    (this.ageMaterial.uniforms.uSub.value as Vector4).copy(amount);
    this.withTarget(renderer, (index) => {
      if (index === target) renderer.render(this.ageScene, this.camera);
    });
  }

  /** Erases every target (Reset Opponent / Clean Floor). */
  clear(renderer: WebGLRenderer): void {
    for (const q of this.queues) q.length = 0;
    this.withTarget(renderer, () => renderer.clear(true, false, false));
  }

  /** Recreates the targets at a new resolution (quality preset change); contents are lost. */
  resize(size: number): void {
    for (const t of this.targets) t.setSize(size, size);
  }

  private withTarget(renderer: WebGLRenderer, draw: (index: number) => void): void {
    renderOffscreen(renderer, this.targets, draw);
  }
}

const _clear = new Color();

/**
 * Renders into offscreen targets with XR, auto-clear and the clear colour set
 * up for painting (XR disabled so three doesn't swap in the headset camera),
 * restoring everything afterwards.
 */
export function renderOffscreen(
  renderer: WebGLRenderer,
  targets: readonly WebGLRenderTarget[],
  draw: (index: number) => void,
): void {
  const previousTarget = renderer.getRenderTarget();
  const xrEnabled = renderer.xr.enabled;
  const autoClear = renderer.autoClear;
  const clearAlpha = renderer.getClearAlpha();
  renderer.getClearColor(_clear);
  renderer.xr.enabled = false;
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);
  targets.forEach((target, index) => {
    renderer.setRenderTarget(target);
    draw(index);
  });
  renderer.setRenderTarget(previousTarget);
  renderer.setClearColor(_clear, clearAlpha);
  renderer.autoClear = autoClear;
  renderer.xr.enabled = xrEnabled;
}
