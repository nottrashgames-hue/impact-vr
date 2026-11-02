import { type Camera, CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from 'three';

/**
 * Red vignette flash when the sparring opponent lands a jab on the player
 * (Section 3: "no damage to player, just a screen flash/haptic"). A
 * transparent plane just in front of the camera, so it works in VR too.
 */
export class HitFlash {
  private readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private strength = 0;

  constructor(camera: Camera) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    const g = ctx.createRadialGradient(128, 128, 40, 128, 128, 160);
    g.addColorStop(0, 'rgba(200,0,0,0)');
    g.addColorStop(0.6, 'rgba(200,0,0,0.35)');
    g.addColorStop(1, 'rgba(160,0,0,0.9)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    this.mesh = new Mesh(
      new PlaneGeometry(0.5, 0.5),
      new MeshBasicMaterial({ map: texture, transparent: true, opacity: 0, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    this.mesh.position.set(0, 0, -0.1);
    this.mesh.renderOrder = 60;
    this.mesh.visible = false;
    camera.add(this.mesh);
  }

  flash(strength = 1): void {
    this.strength = Math.min(1, Math.max(this.strength, strength));
  }

  update(dt: number): void {
    this.strength = Math.max(0, this.strength - dt * 2.5);
    this.mesh.visible = this.strength > 0.01;
    this.mesh.material.opacity = this.strength;
  }
}
