import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three';

/**
 * Procedurally generated environment textures (no external assets required).
 * Generated once at startup with a seeded RNG so the gym looks the same every run.
 */

type Ctx = CanvasRenderingContext2D;

/** Small deterministic PRNG (mulberry32). */
function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createCanvas(width: number, height: number): [HTMLCanvasElement, Ctx] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return [canvas, ctx];
}

function toTexture(canvas: HTMLCanvasElement, anisotropy: number, repeat: boolean): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = anisotropy;
  if (repeat) {
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
  }
  return texture;
}

/** Adds per-pixel luminance noise (and an optional pattern) to the whole canvas. */
function addNoise(
  ctx: Ctx,
  rng: () => number,
  amount: number,
  pattern?: (x: number, y: number) => number,
): void {
  const { width, height } = ctx.canvas;
  const image = ctx.getImageData(0, 0, width, height);
  const d = image.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const n = (rng() - 0.5) * amount + (pattern ? pattern(x, y) : 0);
      d[i] = Math.max(0, Math.min(255, d[i] + n));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** Soft radial blotches (scuffs, wear, stains). */
function addBlotches(
  ctx: Ctx,
  rng: () => number,
  count: number,
  color: string,
  minR: number,
  maxR: number,
  alpha: number,
): void {
  const { width, height } = ctx.canvas;
  for (let i = 0; i < count; i++) {
    const x = rng() * width;
    const y = rng() * height;
    const r = minR + rng() * (maxR - minR);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = alpha * (0.4 + rng() * 0.6);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.globalAlpha = 1;
}

/**
 * Ring canvas: light blue-grey woven canvas with scuffs, a darker apron band
 * outside the ropes and a faded centre logo. One texture for the whole floor
 * plane (UV 0..1 = the full canvas), which the blood map will overlay later.
 *
 * @param ropeFraction fraction of the texture (from the edge) that lies outside the ropes
 */
export function createRingCanvasTexture(size: number, ropeFraction: number, anisotropy: number): CanvasTexture {
  const rng = createRng(1337);
  const [canvas, ctx] = createCanvas(size, size);

  ctx.fillStyle = '#b9c2cc';
  ctx.fillRect(0, 0, size, size);

  // Apron band outside the ropes, slightly darker and more worn.
  const band = Math.round(size * ropeFraction);
  ctx.fillStyle = 'rgba(40, 55, 80, 0.18)';
  ctx.fillRect(0, 0, size, band);
  ctx.fillRect(0, size - band, size, band);
  ctx.fillRect(0, band, band, size - band * 2);
  ctx.fillRect(size - band, band, band, size - band * 2);

  // Large faded centre logo.
  const c = size / 2;
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.strokeStyle = '#1b2f5c';
  ctx.lineWidth = size * 0.012;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = size * 0.004;
  ctx.beginPath();
  ctx.arc(c, c, size * 0.18, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#1b2f5c';
  ctx.font = `900 ${Math.round(size * 0.075)}px system-ui, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('IMPACT', c, c);
  ctx.restore();

  // Wear: darker scuffs concentrated around the centre where fighters move.
  addBlotches(ctx, rng, 90, 'rgba(70, 72, 78, 1)', size * 0.01, size * 0.06, 0.12);
  addBlotches(ctx, rng, 30, 'rgba(255, 255, 255, 1)', size * 0.02, size * 0.08, 0.1);

  // Canvas weave: a fine checker of over/under threads plus grain noise.
  addNoise(ctx, rng, 14, (x, y) => (((x >> 1) + (y >> 1)) & 1 ? 3 : -3));

  return toTexture(canvas, anisotropy, false);
}

/** Rubber gym flooring tile (1 m), dark with coloured EPDM flecks and seams. Repeats. */
export function createRubberTileTexture(anisotropy: number): CanvasTexture {
  const size = 512;
  const rng = createRng(42);
  const [canvas, ctx] = createCanvas(size, size);
  ctx.fillStyle = '#2a2c30';
  ctx.fillRect(0, 0, size, size);

  const flecks = ['#5a6070', '#3d4250', '#6b7180', '#40506a'];
  for (let i = 0; i < 9000; i++) {
    ctx.fillStyle = flecks[(rng() * flecks.length) | 0];
    const s = 1 + rng() * 2.2;
    ctx.fillRect(rng() * size, rng() * size, s, s);
  }
  addBlotches(ctx, rng, 12, 'rgba(0,0,0,1)', 30, 90, 0.18);
  addNoise(ctx, rng, 10);

  // Tile seams on the edges so tiling reads as individual tiles.
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, size, 3);
  ctx.fillRect(0, 0, 3, size);
  return toTexture(canvas, anisotropy, true);
}

/** Painted concrete-block wall: covers 1.6 m × 1.6 m (4 × 8 blocks). Repeats. */
export function createBlockWallTexture(anisotropy: number): CanvasTexture {
  const size = 512;
  const rng = createRng(7);
  const [canvas, ctx] = createCanvas(size, size);
  ctx.fillStyle = '#6f7682'; // mortar
  ctx.fillRect(0, 0, size, size);

  const cols = 4;
  const rows = 8;
  const bw = size / cols;
  const bh = size / rows;
  const mortar = 4;
  for (let r = 0; r < rows; r++) {
    const offset = r % 2 === 0 ? 0 : bw / 2;
    for (let col = -1; col <= cols; col++) {
      const shade = 128 + Math.round((rng() - 0.5) * 10);
      ctx.fillStyle = `rgb(${shade}, ${shade + 6}, ${shade + 16})`;
      ctx.fillRect(col * bw + offset + mortar / 2, r * bh + mortar / 2, bw - mortar, bh - mortar);
    }
  }
  addBlotches(ctx, rng, 18, 'rgba(40,40,40,1)', 20, 80, 0.08);
  addNoise(ctx, rng, 16);
  return toTexture(canvas, anisotropy, true);
}

/** Vinyl wall/corner padding: greyscale tufted panel (tinted by vertex colour). Repeats horizontally every 1.2 m. */
export function createPaddingTexture(anisotropy: number): CanvasTexture {
  const w = 256;
  const h = 512;
  const rng = createRng(99);
  const [canvas, ctx] = createCanvas(w, h);
  const g = ctx.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, '#9a9a9a');
  g.addColorStop(0.08, '#f2f2f2');
  g.addColorStop(0.5, '#ffffff');
  g.addColorStop(0.92, '#f2f2f2');
  g.addColorStop(1, '#9a9a9a');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // Horizontal stitched seams.
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  for (let y = h / 4; y < h; y += h / 4) ctx.fillRect(0, y - 2, w, 4);
  addNoise(ctx, rng, 8);
  return toTexture(canvas, anisotropy, true);
}

/** Ring skirt: navy fabric with repeating "IMPACT" lettering (4:1). Repeats horizontally. */
export function createSkirtTexture(anisotropy: number): CanvasTexture {
  const w = 1024;
  const h = 256;
  const rng = createRng(5);
  const [canvas, ctx] = createCanvas(w, h);
  ctx.fillStyle = '#16213d';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#b3171b';
  ctx.fillRect(0, 0, w, 14);
  ctx.fillStyle = '#e9ecf1';
  ctx.font = '900 120px system-ui, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('IMPACT', w / 2, h * 0.52);
  addNoise(ctx, rng, 10);
  return toTexture(canvas, anisotropy, true);
}

/** Leather heavy-bag texture: wraps around a cylinder, with a stitched label band. */
export function createLeatherTexture(anisotropy: number): CanvasTexture {
  const w = 512;
  const h = 512;
  const rng = createRng(21);
  const [canvas, ctx] = createCanvas(w, h);
  ctx.fillStyle = '#5a1416';
  ctx.fillRect(0, 0, w, h);
  addBlotches(ctx, rng, 40, 'rgba(0,0,0,1)', 20, 70, 0.25);
  addBlotches(ctx, rng, 20, 'rgba(255,190,170,1)', 10, 40, 0.06);
  // Vertical panel seams.
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  for (let x = 0; x < w; x += w / 4) ctx.fillRect(x, 0, 3, h);
  // Black label band with lettering.
  ctx.fillStyle = '#121212';
  ctx.fillRect(0, h * 0.38, w, h * 0.22);
  ctx.fillStyle = '#d8d8d8';
  ctx.font = '800 56px system-ui, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('IMPACT', w * 0.25, h * 0.49);
  ctx.fillText('IMPACT', w * 0.75, h * 0.49);
  addNoise(ctx, rng, 12);
  return toTexture(canvas, anisotropy, true);
}

/** Painted metal locker door with vents and handle. */
export function createLockerTexture(anisotropy: number): CanvasTexture {
  const w = 256;
  const h = 512;
  const rng = createRng(3);
  const [canvas, ctx] = createCanvas(w, h);
  ctx.fillStyle = '#4a5b73';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 6;
  ctx.strokeRect(6, 6, w - 12, h - 12);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  for (let i = 0; i < 6; i++) {
    ctx.fillRect(w * 0.25, 40 + i * 14, w * 0.5, 6);
    ctx.fillRect(w * 0.25, h - 120 + i * 14, w * 0.5, 6);
  }
  ctx.fillStyle = '#9aa3ad';
  ctx.fillRect(w * 0.78, h * 0.45, 14, 54);
  ctx.fillStyle = '#d9d2b8';
  ctx.fillRect(w * 0.38, h * 0.3, w * 0.24, 22);
  addBlotches(ctx, rng, 10, 'rgba(0,0,0,1)', 10, 40, 0.12);
  addNoise(ctx, rng, 10);
  return toTexture(canvas, anisotropy, false);
}

/** Two portrait banners side by side (left: club logo, right: motto). */
export function createBannerAtlasTexture(anisotropy: number): CanvasTexture {
  const w = 1024;
  const h = 1024;
  const rng = createRng(11);
  const [canvas, ctx] = createCanvas(w, h);
  const half = w / 2;

  // Left banner: red with club name.
  ctx.fillStyle = '#9e1418';
  ctx.fillRect(0, 0, half, h);
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, half, 60);
  ctx.fillRect(0, h - 60, half, 60);
  ctx.fillStyle = '#f4f4f4';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '900 110px system-ui, Arial, sans-serif';
  ctx.fillText('IMPACT', half / 2, h * 0.38);
  ctx.font = '700 46px system-ui, Arial, sans-serif';
  ctx.fillText('BOXING CLUB', half / 2, h * 0.5);
  ctx.font = '600 30px system-ui, Arial, sans-serif';
  ctx.fillText('EST. 2026', half / 2, h * 0.6);

  // Right banner: dark navy with a three-word motto.
  ctx.fillStyle = '#152241';
  ctx.fillRect(half, 0, half, h);
  ctx.fillStyle = '#b3171b';
  ctx.fillRect(half, 0, half, 60);
  ctx.fillRect(half, h - 60, half, 60);
  ctx.fillStyle = '#f4f4f4';
  ctx.font = '900 84px system-ui, Arial, sans-serif';
  ['DISCIPLINE', 'HEART', 'GRIT'].forEach((word, i) => {
    ctx.fillText(word, half + half / 2, h * (0.32 + i * 0.18));
  });

  addNoise(ctx, rng, 12);
  return toTexture(canvas, anisotropy, false);
}
