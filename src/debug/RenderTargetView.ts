import { CanvasTexture, Group, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace, type Texture, Vector3 } from 'three';
import { WORLD } from '../config';

/**
 * Debug panels showing the paint render targets (Section 12): the opponent's
 * damage map and blood map, and the floor blood map. Placed to the player's
 * left, next to the performance HUD.
 */
export class RenderTargetView {
  readonly group = new Group();

  constructor(textures: readonly { texture: Texture; label: string }[]) {
    this.group.name = 'render-target-view';
    this.group.visible = false;
    const size = 0.3;
    textures.forEach(({ texture, label }, i) => {
      const plane = new Mesh(
        new PlaneGeometry(size, size),
        new MeshBasicMaterial({ map: texture, toneMapped: false, transparent: false }),
      );
      plane.position.set(0, -i * (size + 0.07), 0);
      this.group.add(plane);
      const caption = new Mesh(new PlaneGeometry(size, 0.04), new MeshBasicMaterial({ map: labelTexture(label), transparent: true, toneMapped: false }));
      caption.position.set(0, -i * (size + 0.07) + size / 2 + 0.025, 0.001);
      this.group.add(caption);
    });
    this.group.position.set(WORLD.playerSpawnX - 1.25, 2.0, WORLD.playerSpawnZ - 0.5);
    this.group.lookAt(new Vector3(WORLD.playerSpawnX, 1.6, WORLD.playerSpawnZ));
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }
}

function labelTexture(text: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.fillStyle = 'rgba(14,16,20,0.85)';
  ctx.fillRect(0, 0, 512, 64);
  ctx.fillStyle = '#e9ecf1';
  ctx.font = '600 30px system-ui, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 33);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
