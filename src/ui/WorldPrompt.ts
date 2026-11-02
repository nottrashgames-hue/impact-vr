import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, type Vector3 } from 'three';

const WIDTH = 512;
const HEIGHT = 160;

/**
 * A floating text panel in the world (VR-readable), e.g. the knockout prompt.
 * Redraws only when its text changes.
 */
export class WorldPrompt {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private current = '';

  constructor(widthMetres = 0.8) {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.texture = new CanvasTexture(canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.mesh = new Mesh(
      new PlaneGeometry(widthMetres, (widthMetres * HEIGHT) / WIDTH),
      new MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false, depthWrite: false }),
    );
    this.mesh.renderOrder = 15;
    this.mesh.visible = false;
  }

  /** Places the panel and turns it to face a point (e.g. the player's head). */
  place(position: Vector3, lookAt: Vector3): void {
    this.mesh.position.copy(position);
    this.mesh.lookAt(lookAt);
  }

  show(title: string, subtitle: string): void {
    const key = `${title}\n${subtitle}`;
    this.mesh.visible = true;
    if (key === this.current) return;
    this.current = key;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = 'rgba(10, 12, 16, 0.82)';
    ctx.beginPath();
    ctx.roundRect(0, 0, WIDTH, HEIGHT, 22);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff4b3e';
    ctx.font = '900 58px system-ui, Arial, sans-serif';
    ctx.fillText(title, WIDTH / 2, 58);
    ctx.fillStyle = '#e9ecf1';
    ctx.font = '600 26px system-ui, Arial, sans-serif';
    ctx.fillText(subtitle, WIDTH / 2, 118, WIDTH - 40);
    this.texture.needsUpdate = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }
}
