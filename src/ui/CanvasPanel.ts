import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, type Vector2 } from 'three';

export type WidgetKind = 'button' | 'toggle' | 'option' | 'slider' | 'label' | 'header' | 'tab';

/** A rectangle on the panel (canvas pixels) with behaviour. */
export interface Widget {
  readonly kind: WidgetKind;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly text: string;
  /** Toggle/option/tab: selected? Slider: 0..1 position. */
  readonly state?: () => boolean | number;
  /** Slider: value text shown at the right. */
  readonly valueText?: () => string;
  /** Called with the horizontal click position within the widget (0..1). */
  readonly action?: (fraction: number) => void;
  /** Optional colour swatch (CSS colour) drawn on the widget. */
  readonly swatch?: string;
}

const BG = 'rgba(14, 16, 20, 0.92)';
const FG = '#e9ecf1';
const MUTED = '#9aa3b2';
const ACCENT = '#d8322e';
const CHIP = 'rgba(255, 255, 255, 0.08)';
const CHIP_HOVER = 'rgba(255, 255, 255, 0.18)';

/**
 * A simple immediate-mode-ish UI drawn into a 2D canvas: shown as a textured
 * plane in VR (pointed at with a controller ray or poked with a finger) and
 * as a DOM canvas on desktop (clicked with the mouse). Redraws only when
 * something changes or periodically for live values.
 */
export class CanvasPanel {
  readonly canvas: HTMLCanvasElement;
  readonly texture: CanvasTexture;
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly ctx: CanvasRenderingContext2D;
  private widgets: Widget[] = [];
  private hovered: Widget | null = null;
  private dirty = true;
  private sinceDraw = 0;
  /** Extra custom drawing after the widgets (e.g. charts). */
  drawExtra: ((ctx: CanvasRenderingContext2D) => void) | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    worldWidth: number,
    private readonly title: string,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.mesh = new Mesh(
      new PlaneGeometry(worldWidth, (worldWidth * height) / width),
      new MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false }),
    );
    this.mesh.renderOrder = 12;
    this.mesh.visible = false;
  }

  setWidgets(widgets: Widget[]): void {
    this.widgets = widgets;
    this.hovered = null;
    this.dirty = true;
  }

  invalidate(): void {
    this.dirty = true;
  }

  /** UV on the panel mesh -> canvas pixels. */
  uvToPixels(uv: Vector2): [number, number] {
    return [uv.x * this.width, (1 - uv.y) * this.height];
  }

  hover(x: number | null, y = 0): void {
    const w = x === null ? null : this.hit(x, y);
    if (w !== this.hovered) {
      this.hovered = w;
      this.dirty = true;
    }
  }

  /** Returns true if a widget handled the click. */
  click(x: number, y: number): boolean {
    const w = this.hit(x, y);
    if (!w?.action) return false;
    w.action(Math.min(1, Math.max(0, (x - w.x) / w.w)));
    this.dirty = true;
    return true;
  }

  update(dt: number): void {
    this.sinceDraw += dt;
    if (!this.dirty && this.sinceDraw < 0.3) return;
    this.dirty = false;
    this.sinceDraw = 0;
    this.draw();
  }

  private hit(x: number, y: number): Widget | null {
    for (const w of this.widgets) {
      if (w.action && x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return w;
    }
    return null;
  }

  private draw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = BG;
    ctx.beginPath();
    ctx.roundRect(0, 0, this.width, this.height, 24);
    ctx.fill();
    ctx.fillStyle = FG;
    ctx.font = '800 30px system-ui, Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(this.title, 24, 34);

    for (const w of this.widgets) this.drawWidget(w);
    this.drawExtra?.(ctx);
    this.texture.needsUpdate = true;
  }

  private drawWidget(w: Widget): void {
    const ctx = this.ctx;
    const hovered = w === this.hovered;
    const state = w.state?.();
    ctx.textBaseline = 'middle';
    switch (w.kind) {
      case 'header':
        ctx.fillStyle = MUTED;
        ctx.font = '700 19px system-ui, Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(w.text.toUpperCase(), w.x, w.y + w.h / 2);
        return;
      case 'label':
        ctx.fillStyle = FG;
        ctx.font = '500 21px system-ui, Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(w.text, w.x, w.y + w.h / 2);
        return;
      case 'slider': {
        const t = typeof state === 'number' ? state : 0;
        ctx.fillStyle = FG;
        ctx.font = '500 21px system-ui, Arial, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(w.text, w.x, w.y + 12);
        ctx.textAlign = 'right';
        ctx.fillStyle = MUTED;
        ctx.fillText(w.valueText?.() ?? '', w.x + w.w, w.y + 12);
        const ty = w.y + w.h - 14;
        ctx.fillStyle = hovered ? CHIP_HOVER : CHIP;
        ctx.beginPath();
        ctx.roundRect(w.x, ty - 5, w.w, 10, 5);
        ctx.fill();
        ctx.fillStyle = ACCENT;
        ctx.beginPath();
        ctx.roundRect(w.x, ty - 5, Math.max(10, w.w * t), 10, 5);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(w.x + w.w * t, ty, 12, 0, Math.PI * 2);
        ctx.fillStyle = FG;
        ctx.fill();
        return;
      }
      default: {
        const selected = state === true;
        ctx.fillStyle = selected ? ACCENT : hovered ? CHIP_HOVER : CHIP;
        if (w.kind === 'tab' && !selected) ctx.fillStyle = hovered ? CHIP_HOVER : 'rgba(255,255,255,0.04)';
        ctx.beginPath();
        ctx.roundRect(w.x, w.y, w.w, w.h, 12);
        ctx.fill();
        if (hovered) {
          ctx.strokeStyle = 'rgba(255,255,255,0.5)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        let textX = w.x + w.w / 2;
        if (w.swatch) {
          ctx.fillStyle = w.swatch;
          ctx.beginPath();
          ctx.arc(w.x + 22, w.y + w.h / 2, 11, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.6)';
          ctx.lineWidth = 2;
          ctx.stroke();
          textX += 12;
        }
        ctx.fillStyle = FG;
        ctx.font = `${w.kind === 'tab' ? 700 : 600} 21px system-ui, Arial, sans-serif`;
        ctx.textAlign = 'center';
        let text = w.text;
        if (w.kind === 'toggle') text = `${w.text}: ${selected ? 'On' : 'Off'}`;
        ctx.fillText(text, textX, w.y + w.h / 2 + 1, w.w - 16);
      }
    }
  }
}
