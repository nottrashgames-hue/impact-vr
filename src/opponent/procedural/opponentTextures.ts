import { Color } from 'three';
import { createSmoothCurve, hash2, smoothstep, sq, valueNoise } from '../../core/mathUtils';
import { ZONES, type ZoneId } from '../../damage/Zones';
import { classifyFacePoint, headRegionCode } from '../FaceRegions';
import { ATLAS, torsoHalfWidthAt, torsoHeightAtV } from './BodyLayout';
import type { AtlasRect } from './geometryBuilders';
import { almondMask, angleFromS, createSample, EYE_X, EYE_Y, sampleBase, yFromV } from './HeadModel';

/** sRGB 0..255 working colour. */
type RGB = [number, number, number];

const SKIN: RGB = [182, 130, 100];
const HAIR: RGB = [40, 32, 27];
const BROW: RGB = [42, 30, 24];
const LIPS: RGB = [166, 92, 86];
const SHORTS_RED: RGB = [168, 22, 28];
const WHITE: RGB = [236, 236, 236];
const GOLD: RGB = [214, 170, 60];

function mix(c: RGB, t: RGB, a: number): void {
  if (a <= 0) return;
  const k = Math.min(1, a);
  c[0] += (t[0] - c[0]) * k;
  c[1] += (t[1] - c[1]) * k;
  c[2] += (t[2] - c[2]) * k;
}

function scale(c: RGB, r: number, g: number, b: number): void {
  c[0] *= r;
  c[1] *= g;
  c[2] *= b;
}

function inRect(u: number, v: number, r: AtlasRect): boolean {
  return u >= r.u0 && u < r.u0 + r.w && v >= r.v0 && v < r.v0 + r.h;
}

/** Hairline height (head space y) by absolute slice angle: forehead, temples, sideburns, above the ears, nape. */
const hairlineY = createSmoothCurve(
  [0, 0.6, 0.95, 1.15, 1.3, 1.42, 1.55, 1.75, 2.1, Math.PI],
  [0.086, 0.088, 0.08, 0.03, -0.02, -0.02, 0.032, 0.03, -0.065, -0.075],
);

const sample = createSample();

/** Paints one head-region pixel. (lu, lv) are 0..1 within the head rect. */
function paintHead(c: RGB, lu: number, lv: number): void {
  const t = angleFromS(lu * 2 - 1);
  const y = yFromV(lv);
  sampleBase(t, y, sample);
  const x = sample.x;
  const ax = Math.abs(x);
  const front = sample.front;
  const at = Math.abs(t);
  const grain = hash2(Math.floor(lu * 4096), Math.floor(lv * 4096));

  // Warmth on the nose and cheeks.
  const red =
    (0.12 * Math.exp(-sq(x / 0.012) - sq((y + 0.035) / 0.018)) +
      0.08 * Math.exp(-sq((ax - 0.045) / 0.02) - sq((y + 0.03) / 0.02))) *
    front;
  c[0] += red * 40;
  c[1] -= red * 14;
  c[2] -= red * 10;

  // Eye area: under-eye shadow, lid crease, inner-corner caruncle, darker opening.
  for (const side of [1, -1]) {
    const dx = x - side * EYE_X;
    const dy = y - EYE_Y;
    const under = Math.exp(-sq(dx / 0.014) - sq((dy + 0.011) / 0.005));
    scale(c, 1 - 0.08 * under, 1 - 0.1 * under, 1 - 0.06 * under);
    const crease = Math.exp(-sq((dy - 0.0085) / 0.0012) - Math.pow(dx / 0.014, 4));
    scale(c, 1 - 0.14 * crease, 1 - 0.16 * crease, 1 - 0.16 * crease);
    const opening = almondMask(dx, dy);
    scale(c, 1 - 0.25 * opening, 1 - 0.35 * opening, 1 - 0.35 * opening);
    const caruncle = Math.exp(-sq((dx + side * 0.0135) / 0.0022) - sq((dy + 0.0005) / 0.0018));
    mix(c, [190, 100, 98], caruncle * 0.8);
  }

  // Eyebrows: arched bands of short hairs.
  if (ax > 0.01 && ax < 0.064 && y > 0.008 && y < 0.034) {
    const p = (ax - 0.01) / 0.054;
    const yb = 0.0205 + 0.0045 * Math.sin(Math.PI * Math.min(1, p * 1.3)) - 0.002 * p;
    const half = 0.0044 * (1 - 0.55 * p);
    const strands = 0.55 + 0.45 * valueNoise(ax * 2600, y * 900);
    const m = smoothstep(half, half * 0.35, Math.abs(y - yb)) * smoothstep(0, 0.1, p) * strands;
    mix(c, BROW, m * 0.92);
  }

  // Stubble over the jaw, chin and upper lip (not the lips themselves).
  const lipUpper = Math.exp(-sq((y + 0.0665) / 0.005) - Math.pow(x / 0.024, 4));
  const lipLower = Math.exp(-sq((y + 0.0815) / 0.0058) - Math.pow(x / 0.022, 4));
  const lips = smoothstep(0.3, 0.75, Math.max(lipUpper, lipLower)) * front;
  // Starts lower in the middle (below the nose and philtrum) than on the jaw sides.
  const stubbleTop = ax < 0.03 ? -0.06 : -0.04;
  const stubble = smoothstep(stubbleTop, stubbleTop - 0.012, y) * (1 - smoothstep(1.35, 1.5, at)) * (1 - lips);
  if (stubble > 0) {
    scale(c, 1 - 0.16 * stubble, 1 - 0.15 * stubble, 1 - 0.1 * stubble);
    if (grain > 0.55) scale(c, 1 - 0.18 * stubble, 1 - 0.18 * stubble, 1 - 0.16 * stubble);
  }

  mix(c, LIPS, lips * 0.85);
  const mouthLine = Math.exp(-sq((y + 0.0745) / 0.0011) - Math.pow(x / 0.025, 6)) * front;
  mix(c, [95, 45, 42], mouthLine * 0.9);
  const nostrils = Math.exp(-sq((ax - 0.0075) / 0.0028) - sq((y + 0.0535) / 0.0016)) * front;
  mix(c, [80, 42, 36], nostrils * 0.75);

  // Buzz-cut hair.
  const hy = hairlineY(at);
  const hair = smoothstep(hy - 0.003, hy + 0.004, y);
  if (hair > 0) mix(c, HAIR, hair * (0.74 + 0.22 * grain));
}

function paintTorso(c: RGB, lu: number, lv: number): void {
  const a = -Math.PI + 2 * Math.PI * lu;
  const y = torsoHeightAtV(lv);
  const x = torsoHalfWidthAt(y) * Math.sin(a);
  const front = Math.max(0, Math.cos(a));
  if (front <= 0) return;
  for (const side of [1, -1]) {
    const d = Math.hypot(x - side * 0.088, y - 1.305);
    mix(c, [160, 104, 86], smoothstep(0.013, 0.009, d) * 0.6 * front);
    mix(c, [130, 80, 66], smoothstep(0.0048, 0.003, d) * front);
  }
  const navel = sq(x / 0.0055) + sq((y - 1.065) / 0.008);
  mix(c, [110, 70, 55], smoothstep(1.2, 0.4, navel) * front);
  const pecShadow = Math.exp(-sq((y - 1.272) / 0.012)) * smoothstep(0.16, 0.12, Math.abs(x)) * front;
  scale(c, 1 - 0.07 * pecShadow, 1 - 0.08 * pecShadow, 1 - 0.08 * pecShadow);
  const alba = Math.exp(-sq(x / 0.004)) * (y > 1.08 && y < 1.26 ? 1 : 0) * front;
  scale(c, 1 - 0.05 * alba, 1 - 0.06 * alba, 1 - 0.06 * alba);
}

function paintEar(c: RGB, lu: number, lv: number): void {
  c[0] += 10;
  c[1] -= 4;
  // Darker bowl on both faces (the inner face is hidden against the head).
  const bowl = Math.min(Math.abs(lu - 0.5), Math.min(lu, 1 - lu));
  const m = smoothstep(0.16, 0.06, bowl) * smoothstep(0.2, 0.4, lv) * smoothstep(0.85, 0.6, lv);
  scale(c, 1 - 0.25 * m, 1 - 0.3 * m, 1 - 0.28 * m);
}

function paintShortsPelvis(c: RGB, lu: number, lv: number): void {
  c[0] = SHORTS_RED[0];
  c[1] = SHORTS_RED[1];
  c[2] = SHORTS_RED[2];
  const sheen = 0.9 + 0.12 * valueNoise(lu * 30, lv * 12);
  scale(c, sheen, sheen, sheen);
  if (lv > 0.8) {
    mix(c, WHITE, 1);
    return;
  }
  const a = -Math.PI + 2 * Math.PI * lu;
  const stripe = Math.min(Math.abs(a - Math.PI / 2), Math.abs(a + Math.PI / 2));
  if (stripe < 0.07) mix(c, GOLD, 1);
}

function paintShortsLeg(c: RGB, lu: number, lv: number, outerAngle: number): void {
  c[0] = SHORTS_RED[0];
  c[1] = SHORTS_RED[1];
  c[2] = SHORTS_RED[2];
  const sheen = 0.9 + 0.12 * valueNoise(lu * 30, lv * 12);
  scale(c, sheen, sheen, sheen);
  const a = -Math.PI + 2 * Math.PI * lu;
  if (Math.abs(a - outerAngle) < 0.12) mix(c, GOLD, 1);
  if (lv < 0.16) mix(c, WHITE, 1);
}

/**
 * Albedo atlas for skin and shorts (Section 3 / 7.4 — the same UV layout is
 * later used by the damage and blood paint targets).
 */
export function paintOpponentAlbedo(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const image = ctx.createImageData(size, size);
  const data = image.data;
  const c: RGB = [0, 0, 0];

  for (let py = 0; py < size; py++) {
    const v = 1 - (py + 0.5) / size;
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      // Base skin with blotchy variation and fine grain.
      const blotch = valueNoise(u * 48, v * 48) * 0.6 + valueNoise(u * 160, v * 160) * 0.4;
      const grain = hash2(px, py) - 0.5;
      c[0] = SKIN[0] * (0.95 + 0.08 * blotch) + grain * 5;
      c[1] = SKIN[1] * (0.95 + 0.07 * blotch) + grain * 5;
      c[2] = SKIN[2] * (0.95 + 0.07 * blotch) + grain * 5;

      if (inRect(u, v, ATLAS.head)) {
        paintHead(c, (u - ATLAS.head.u0) / ATLAS.head.w, (v - ATLAS.head.v0) / ATLAS.head.h);
      } else if (inRect(u, v, ATLAS.torso)) {
        paintTorso(c, (u - ATLAS.torso.u0) / ATLAS.torso.w, (v - ATLAS.torso.v0) / ATLAS.torso.h);
      } else if (inRect(u, v, ATLAS.earLeft) || inRect(u, v, ATLAS.earRight)) {
        const r = inRect(u, v, ATLAS.earLeft) ? ATLAS.earLeft : ATLAS.earRight;
        paintEar(c, (u - r.u0) / r.w, (v - r.v0) / r.h);
      } else if (inRect(u, v, ATLAS.shortsPelvis)) {
        paintShortsPelvis(c, (u - ATLAS.shortsPelvis.u0) / ATLAS.shortsPelvis.w, (v - ATLAS.shortsPelvis.v0) / ATLAS.shortsPelvis.h);
      } else if (inRect(u, v, ATLAS.shortsLegLeft)) {
        const r = ATLAS.shortsLegLeft;
        paintShortsLeg(c, (u - r.u0) / r.w, (v - r.v0) / r.h, Math.PI / 2);
      } else if (inRect(u, v, ATLAS.shortsLegRight)) {
        const r = ATLAS.shortsLegRight;
        paintShortsLeg(c, (u - r.u0) / r.w, (v - r.v0) / r.h, -Math.PI / 2);
      }

      const i = (py * size + px) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  // Waistband lettering (front centre of the pelvis band).
  const band = ATLAS.shortsPelvis;
  ctx.fillStyle = '#a8161c';
  ctx.font = `900 ${Math.round(size * band.h * 0.14)}px system-ui, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('IMPACT', (band.u0 + band.w * 0.5) * size, (1 - (band.v0 + band.h * 0.9)) * size);
  return canvas;
}

export interface FaceRegionMaps {
  /** Region code per texel (row 0 = v = 1), over the full UV space. */
  readonly mask: Uint8Array;
  readonly size: number;
  /** Zone colours over the full UV space, for the hitbox/zone debug view. */
  readonly zoneCanvas: HTMLCanvasElement;
}

/** Builds the face-region UV mask and a zone-coloured debug atlas. */
export function buildFaceRegionMaps(size: number): FaceRegionMaps {
  const mask = new Uint8Array(size * size);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const image = ctx.createImageData(size, size);
  const color = new Color();
  const zoneRgb = (zone: ZoneId): RGB => {
    color.setHex(ZONES[zone].color);
    return [color.r * 255, color.g * 255, color.b * 255];
  };

  for (let py = 0; py < size; py++) {
    const v = 1 - (py + 0.5) / size;
    for (let px = 0; px < size; px++) {
      const u = (px + 0.5) / size;
      let zone: ZoneId = 'head';
      if (inRect(u, v, ATLAS.head)) {
        const lu = (u - ATLAS.head.u0) / ATLAS.head.w;
        const lv = (v - ATLAS.head.v0) / ATLAS.head.h;
        const y = yFromV(lv);
        sampleBase(angleFromS(lu * 2 - 1), y, sample);
        const region = classifyFacePoint(sample.x, y, sample.front);
        mask[py * size + px] = headRegionCode(region);
        zone = region;
      } else if (inRect(u, v, ATLAS.torso)) {
        zone = torsoHeightAtV((v - ATLAS.torso.v0) / ATLAS.torso.h) < 1.17 ? 'stomach' : 'torso';
      } else if (inRect(u, v, ATLAS.armLeft) || inRect(u, v, ATLAS.armRight)) {
        zone = 'arms';
      } else if (
        inRect(u, v, ATLAS.legLeft) ||
        inRect(u, v, ATLAS.legRight) ||
        inRect(u, v, ATLAS.shortsLegLeft) ||
        inRect(u, v, ATLAS.shortsLegRight)
      ) {
        zone = 'legs';
      } else if (inRect(u, v, ATLAS.shortsPelvis)) {
        zone = 'stomach';
      }
      const [r, g, b] = zoneRgb(zone);
      const i = (py * size + px) * 4;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return { mask, size, zoneCanvas: canvas };
}

/**
 * Eyeball texture for a sphere whose pole faces forward: the top rows (v ≈ 1)
 * are the pupil and iris, the rest is sclera.
 */
export function paintEyeTexture(): HTMLCanvasElement {
  const w = 256;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const image = ctx.createImageData(w, h);
  const c: RGB = [0, 0, 0];
  for (let py = 0; py < h; py++) {
    const polar = ((py + 0.5) / h) * 180; // degrees from the front pole
    for (let px = 0; px < w; px++) {
      const az = px / w;
      if (polar < 9) {
        c[0] = 12;
        c[1] = 10;
        c[2] = 10; // pupil
      } else if (polar < 30) {
        // Iris: radial brown fibres, darker limbal ring at the edge.
        const fibre = valueNoise(az * 90, polar * 0.6);
        const k = 0.7 + 0.5 * fibre;
        c[0] = 96 * k;
        c[1] = 62 * k;
        c[2] = 36 * k;
        const limbus = smoothstep(25, 30, polar);
        mix(c, [40, 28, 20], limbus * 0.8);
        mix(c, [140, 104, 60], smoothstep(14, 9, polar) * 0.4);
      } else {
        // Sclera: off-white, pinker and veined towards the back.
        c[0] = 236;
        c[1] = 228;
        c[2] = 222;
        const back = smoothstep(40, 110, polar);
        mix(c, [222, 170, 160], back * 0.6);
        const vein = smoothstep(0.82, 0.95, valueNoise(az * 60, polar * 0.25)) * back;
        mix(c, [190, 70, 70], vein * 0.7);
        mix(c, [150, 120, 110], smoothstep(30, 34, polar) * smoothstep(40, 33, polar) * 0.35);
      }
      const i = (py * w + px) * 4;
      image.data[i] = c[0];
      image.data[i + 1] = c[1];
      image.data[i + 2] = c[2];
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}
