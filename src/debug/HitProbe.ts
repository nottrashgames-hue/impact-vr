import { Mesh, MeshBasicMaterial, type Scene, SphereGeometry, type Vector3 } from 'three';
import { ZONES } from '../damage/Zones';
import type { Opponent } from '../opponent/Opponent';
import { debugStats } from './DebugStats';

const PROBE_INTERVAL = 1 / 15; // seconds; the head-mesh raycast is CPU-side

/**
 * Debug "what am I pointing at" probe (Section 12): casts from the mouse
 * (desktop) or the right controller (VR) into the opponent and reports the
 * zone, collider and UV under it, with a marker at the hit point.
 */
export class HitProbe {
  private readonly marker: Mesh;
  private sinceProbe = 0;

  constructor(scene: Scene) {
    this.marker = new Mesh(
      new SphereGeometry(0.006, 10, 8),
      new MeshBasicMaterial({ color: 0xffffff, depthTest: false, toneMapped: false }),
    );
    this.marker.renderOrder = 30;
    this.marker.visible = false;
    scene.add(this.marker);
  }

  hide(): void {
    this.marker.visible = false;
    debugStats.probe = '';
  }

  /** @param ray origin + direction to probe along, or null when there is nothing to probe */
  update(dt: number, opponent: Opponent, ray: { origin: Vector3; direction: Vector3 } | null): void {
    this.sinceProbe += dt;
    if (this.sinceProbe < PROBE_INTERVAL) return;
    this.sinceProbe = 0;
    if (!ray) {
      this.hide();
      return;
    }
    const hit = opponent.raycast(ray.origin, ray.direction);
    if (!hit) {
      this.marker.visible = false;
      debugStats.probe = '—';
      return;
    }
    this.marker.visible = true;
    this.marker.position.copy(hit.point);
    (this.marker.material as MeshBasicMaterial).color.setHex(ZONES[hit.zone].color);
    const uv = hit.uv ? `  uv ${hit.uv.x.toFixed(3)},${hit.uv.y.toFixed(3)}` : '';
    debugStats.probe = `${ZONES[hit.zone].label} [${hit.hitbox}]${uv}`;
  }
}
