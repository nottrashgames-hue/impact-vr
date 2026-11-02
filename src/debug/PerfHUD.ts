import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from 'three';
import { WORLD } from '../config';
import type { QualityPreset } from '../core/Quality';
import type { PlayerHands } from '../player/PlayerHands';
import { debugStats } from './DebugStats';

const WIDTH = 512;
const HEIGHT = 404;
const REDRAW_INTERVAL = 0.25; // seconds
const PANEL_WIDTH = 0.5; // metres in VR

export interface HudFrameInfo {
  readonly inXR: boolean;
  /** Headset refresh rate (Hz) when known, else the quality preset's target. */
  readonly displayRate: number;
  readonly hands: PlayerHands;
}

/**
 * Performance HUD (Section 1 & 12): fps, frame time, draw calls, triangles,
 * particles, decals, physics. Drawn into one 2D canvas that is shown as a DOM
 * overlay on desktop and as a world-space panel in VR. Redrawn at 4 Hz so it
 * costs ~nothing.
 */
export class PerfHUD {
  readonly canvas: HTMLCanvasElement;
  /** World-space panel used in VR, placed to the player's front-left. */
  readonly panel: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private enabled: boolean;
  private inXR = false;

  private frames = 0;
  private windowTime = 0;
  private worstFrame = 0;
  private fps = 0;
  private frameMs = 0;
  private worstMs = 0;
  private sinceDraw = REDRAW_INTERVAL;

  constructor(
    private quality: QualityPreset,
    enabled: boolean,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.canvas.className = 'perf-hud';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    document.body.appendChild(this.canvas);

    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    const material = new MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false });
    this.panel = new Mesh(new PlaneGeometry(PANEL_WIDTH, (PANEL_WIDTH * HEIGHT) / WIDTH), material);
    this.panel.name = 'perf-hud';
    this.panel.renderOrder = 10;
    this.panel.position.set(WORLD.playerSpawnX - 0.75, 1.8, WORLD.playerSpawnZ - 0.85);
    this.panel.lookAt(WORLD.playerSpawnX, 1.6, WORLD.playerSpawnZ);

    this.enabled = enabled;
    this.applyVisibility();
  }

  get visible(): boolean {
    return this.enabled;
  }

  toggle(): void {
    this.setVisible(!this.enabled);
  }

  setVisible(visible: boolean): void {
    this.enabled = visible;
    this.applyVisibility();
  }

  setQuality(quality: QualityPreset): void {
    this.quality = quality;
  }

  setXR(inXR: boolean): void {
    this.inXR = inXR;
    this.applyVisibility();
  }

  update(dt: number, info: HudFrameInfo): void {
    this.frames++;
    this.windowTime += dt;
    this.worstFrame = Math.max(this.worstFrame, dt);
    if (this.windowTime >= 0.5) {
      this.fps = this.frames / this.windowTime;
      this.frameMs = (this.windowTime / this.frames) * 1000;
      this.worstMs = this.worstFrame * 1000;
      this.frames = 0;
      this.windowTime = 0;
      this.worstFrame = 0;
    }

    this.sinceDraw += dt;
    if (!this.enabled || this.sinceDraw < REDRAW_INTERVAL) return;
    this.sinceDraw = 0;
    this.draw(info);
    this.texture.needsUpdate = true;
  }

  private applyVisibility(): void {
    this.canvas.classList.toggle('hidden', !this.enabled || this.inXR);
    this.panel.visible = this.enabled && this.inXR;
  }

  private draw(info: HudFrameInfo): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = 'rgba(10, 12, 16, 0.86)';
    ctx.beginPath();
    ctx.roundRect(0, 0, WIDTH, HEIGHT, 18);
    ctx.fill();

    const target = info.displayRate;
    const fpsColor = this.fps >= target * 0.95 ? '#7ee787' : this.fps >= target * 0.8 ? '#f2cc60' : '#ff7b72';
    const hands = info.hands;
    const handText = (h: typeof hands.left): string =>
      h.driver === 'none' ? '  —  ' : `${h.velocity.speed.toFixed(1).padStart(4)} (pk ${h.recentPeakSpeed.toFixed(1)})`;

    const lines: Array<[string, string, string?]> = [
      ['FPS', `${this.fps.toFixed(1)}  /  ${target} Hz`, fpsColor],
      ['Frame', `${this.frameMs.toFixed(1)} ms   worst ${this.worstMs.toFixed(1)} ms`],
      ['Draw calls', `${debugStats.drawCalls}`],
      ['Triangles', `${(debugStats.triangles / 1000).toFixed(1)}k`],
      ['Particles', `${debugStats.particles} / ${this.quality.maxParticles}`],
      ['Decals', `${debugStats.decals}`],
      [
        'Physics',
        `${debugStats.physicsBodies} bodies  ${debugStats.physicsColliders} cols  ${debugStats.physicsMs.toFixed(2)} ms`,
      ],
      ['Hands', `L ${hands.left.driver}   R ${hands.right.driver}`],
      ['Speed m/s', `L ${handText(hands.left)}  R ${handText(hands.right)}`],
      ['Opponent', debugStats.opponent],
      ['Probe', debugStats.probe || 'press B (desktop) / X (VR)'],
      ['Last hit', debugStats.lastHit || '—'],
      ['Damage', debugStats.knockout],
    ];

    ctx.font = '700 20px ui-monospace, Consolas, monospace';
    ctx.fillStyle = '#e9ecf1';
    ctx.fillText('IMPACT  debug', 18, 32);
    ctx.fillStyle = '#9aa3b2';
    ctx.textAlign = 'right';
    ctx.fillText(`${this.quality.label} · ${info.inXR ? 'VR' : 'Desktop'}`, WIDTH - 18, 32);
    ctx.textAlign = 'left';

    ctx.font = '17px ui-monospace, Consolas, monospace';
    lines.forEach(([label, value, color], i) => {
      const y = 66 + i * 26;
      ctx.fillStyle = '#9aa3b2';
      ctx.fillText(label, 18, y);
      ctx.fillStyle = color ?? '#e9ecf1';
      ctx.fillText(value, 140, y, WIDTH - 158);
    });
  }
}
