import {
  BufferGeometry,
  Float32BufferAttribute,
  Line,
  LineBasicMaterial,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  type Scene,
  SphereGeometry,
  Vector3,
} from 'three';
import type { XRInput } from '../input/XRInput';
import type { CanvasPanel } from './CanvasPanel';

const MAX_RAY = 2;
/** Fingertip distance (m) to the panel plane that counts as a poke, and to re-arm. */
const POKE_ON = 0.012;
const POKE_OFF = 0.03;

const _origin = new Vector3();
const _dir = new Vector3();
const _local = new Vector3();
const _inv = new Matrix4();

/**
 * VR pointing for world-space panels (Section 10): a ray from the right
 * controller (trigger clicks) or a poke with the right index fingertip when
 * hand tracking.
 */
export class UIPointer {
  private readonly raycaster = new Raycaster();
  private readonly line: Line;
  private readonly cursor: Mesh;
  private target: { panel: CanvasPanel; x: number; y: number } | null = null;
  private pokeArmed = true;

  constructor(
    scene: Scene,
    private readonly input: XRInput,
  ) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, -1], 3));
    this.line = new Line(geometry, new LineBasicMaterial({ color: 0xe9ecf1, transparent: true, opacity: 0.7 }));
    this.line.matrixAutoUpdate = false;
    this.line.visible = false;
    this.cursor = new Mesh(new SphereGeometry(0.005, 10, 8), new MeshBasicMaterial({ color: 0xd8322e, depthTest: false }));
    this.cursor.renderOrder = 40;
    this.cursor.visible = false;
    scene.add(this.line, this.cursor);
  }

  /** Whether the ray is currently over a panel (so the trigger means "click", not anything else). */
  get engaged(): boolean {
    return this.target !== null;
  }

  update(panels: readonly CanvasPanel[]): void {
    this.track(panels);
    // Hover only changes (and triggers a redraw) when the target actually changes.
    for (const p of panels) {
      if (this.target?.panel === p) p.hover(this.target.x, this.target.y);
      else p.hover(null);
    }
  }

  private track(panels: readonly CanvasPanel[]): void {
    const visible = panels.filter((p) => p.mesh.visible);
    this.target = null;
    this.line.visible = false;
    this.cursor.visible = false;
    if (visible.length === 0) return;

    const slot = this.input.slotFor('right');
    const mode = this.input.modeOf('right');
    if (!slot || !mode) return;

    if (mode === 'hand') {
      this.poke(slot.hand.joints['index-finger-tip'], visible);
      return;
    }
    if (!slot.targetRay.visible) return;
    slot.targetRay.updateWorldMatrix(true, false);
    _origin.setFromMatrixPosition(slot.targetRay.matrixWorld);
    _dir.set(0, 0, -1).transformDirection(slot.targetRay.matrixWorld);
    this.raycaster.set(_origin, _dir);
    this.raycaster.far = MAX_RAY;
    const hits = this.raycaster.intersectObjects(
      visible.map((p) => p.mesh),
      false,
    );
    const hit = hits[0];
    let length = 0.4;
    if (hit?.uv) {
      const panel = visible.find((p) => p.mesh === hit.object);
      if (panel) {
        const [x, y] = panel.uvToPixels(hit.uv);
        this.target = { panel, x, y };
        this.cursor.position.copy(hit.point);
        this.cursor.visible = true;
        length = hit.distance;
      }
    }
    this.line.matrix.copy(slot.targetRay.matrixWorld).multiply(_inv.makeScale(1, 1, length));
    this.line.matrixWorldNeedsUpdate = true;
    this.line.visible = true;
  }

  /** Trigger pressed on the right controller. Returns true if it clicked a panel. */
  click(): boolean {
    if (!this.target) return false;
    return this.target.panel.click(this.target.x, this.target.y);
  }

  private poke(tip: { visible: boolean; matrixWorld: Matrix4 } | undefined, panels: readonly CanvasPanel[]): void {
    if (!tip?.visible) return;
    _origin.setFromMatrixPosition(tip.matrixWorld);
    for (const panel of panels) {
      const mesh = panel.mesh;
      _local.copy(_origin).applyMatrix4(_inv.copy(mesh.matrixWorld).invert());
      const params = mesh.geometry.parameters;
      const u = _local.x / params.width + 0.5;
      const v = _local.y / params.height + 0.5;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const x = u * panel.width;
      const y = (1 - v) * panel.height;
      this.target = { panel, x, y };
      const depth = Math.abs(_local.z);
      if (this.pokeArmed && depth < POKE_ON) {
        this.pokeArmed = false;
        panel.click(x, y);
        this.input.pulse('right', 0.3, 20);
      } else if (depth > POKE_OFF) {
        this.pokeArmed = true;
      }
      return;
    }
  }
}
