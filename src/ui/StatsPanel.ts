import { Vector3 } from 'three';
import { WORLD } from '../config';
import type { DamageModel } from '../damage/DamageModel';
import type { PunchStats } from '../damage/HitPipeline';
import type { PunchType } from '../damage/Impact';
import type { ZoneId } from '../damage/Zones';
import { CanvasPanel } from './CanvasPanel';

const W = 600;
const H = 520;
const TYPES: readonly PunchType[] = ['jab', 'cross', 'hook', 'uppercut', 'slap'];

/**
 * Floating stats panel (Section 10): punch count, strongest punch, punch-type
 * breakdown and damage per zone on a small head/body diagram. Floats to the
 * right of the opponent in VR; a corner overlay on desktop.
 */
export class StatsPanel {
  readonly panel = new CanvasPanel(W, H, 0.42, 'Round stats');
  private visible = false;

  constructor(
    private readonly stats: PunchStats,
    private readonly damage: DamageModel,
  ) {
    this.panel.drawExtra = (ctx) => this.draw(ctx);
    this.panel.mesh.position.set(WORLD.opponentX + 0.95, 1.65, WORLD.opponentZ - 0.1);
    this.panel.mesh.lookAt(new Vector3(WORLD.playerSpawnX, 1.6, WORLD.playerSpawnZ));
    this.panel.canvas.className = 'stats-panel hidden';
    document.body.appendChild(this.panel.canvas);
  }

  setVisible(visible: boolean, inXR: boolean): void {
    this.visible = visible;
    this.panel.mesh.visible = visible && inXR;
    this.panel.canvas.classList.toggle('hidden', !visible || inXR);
  }

  update(dt: number): void {
    if (this.visible) this.panel.update(dt);
  }

  private draw(ctx: CanvasRenderingContext2D): void {
    const s = this.stats;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e9ecf1';
    ctx.font = '700 26px system-ui, Arial, sans-serif';
    ctx.fillText(`${s.punches} punches`, 24, 84);
    ctx.fillStyle = '#9aa3b2';
    ctx.font = '500 22px system-ui, Arial, sans-serif';
    ctx.fillText(`Strongest ${s.strongest.toFixed(1)} m/s`, 24, 118);

    // Punch-type bars.
    const max = Math.max(1, ...TYPES.map((t) => s.byType[t]));
    TYPES.forEach((t, i) => {
      const y = 160 + i * 40;
      ctx.fillStyle = '#9aa3b2';
      ctx.font = '500 20px system-ui, Arial, sans-serif';
      ctx.fillText(t, 24, y);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(120, y - 11, 170, 22);
      ctx.fillStyle = '#d8322e';
      ctx.fillRect(120, y - 11, (170 * s.byType[t]) / max, 22);
      ctx.fillStyle = '#e9ecf1';
      ctx.fillText(String(s.byType[t]), 300, y);
    });

    // Damage diagram: zones tinted from white (none) to deep red (100).
    const z = (id: ZoneId): string => {
      const d = Math.min(100, this.damage.zones[id].damage) / 100;
      return `rgb(${Math.round(240 - 70 * d)}, ${Math.round(235 - 215 * d)}, ${Math.round(230 - 215 * d)})`;
    };
    const cx = 470;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 2;
    const ellipse = (x: number, y: number, rx: number, ry: number, fill: string): void => {
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.stroke();
    };
    ellipse(cx, 175, 62, 78, z('head'));
    ellipse(cx, 128, 40, 14, z('brow'));
    ellipse(cx - 24, 160, 15, 11, z('eyeRight')); // character's right eye is on the viewer's left
    ellipse(cx + 24, 160, 15, 11, z('eyeLeft'));
    ellipse(cx, 188, 10, 18, z('nose'));
    ellipse(cx - 34, 196, 14, 18, z('cheekRight'));
    ellipse(cx + 34, 196, 14, 18, z('cheekLeft'));
    ellipse(cx, 224, 22, 9, z('mouth'));
    ellipse(cx, 246, 26, 10, z('jaw'));
    ctx.fillStyle = z('torso');
    ctx.fillRect(cx - 70, 275, 140, 90);
    ctx.strokeRect(cx - 70, 275, 140, 90);
    ctx.fillStyle = z('stomach');
    ctx.fillRect(cx - 60, 365, 120, 80);
    ctx.strokeRect(cx - 60, 365, 120, 80);
    ctx.fillStyle = z('arms');
    for (const sx of [-1, 1]) {
      ctx.fillRect(cx + sx * 95 - 15, 280, 30, 140);
      ctx.strokeRect(cx + sx * 95 - 15, 280, 30, 140);
    }
    ctx.fillStyle = '#9aa3b2';
    ctx.font = '500 18px system-ui, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`KO meter ${this.damage.knockoutMeter.toFixed(0)}%`, cx, 478);
  }
}
