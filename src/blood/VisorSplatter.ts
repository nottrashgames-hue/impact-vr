import {
  type Camera,
  CanvasTexture,
  type Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';

const MAX_DROPS = 10;
const LIFETIME = 2.6;
/** Droplets closer than this to the eyes, moving towards them, land on the "visor". */
const RANGE = 0.16;

interface Drop {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  age: number;
}

const _local = new Vector3();

/**
 * Optional "visor" splatter (Section 7.6, off by default): a few droplets that
 * fly into the player's face show as brief red specks in front of the eyes,
 * fading out after a couple of seconds. Attached to the camera, so it follows
 * the headset.
 */
export class VisorSplatter {
  private readonly group = new Group();
  private readonly drops: Drop[] = [];

  constructor(camera: Camera) {
    this.group.name = 'visor-splatter';
    camera.add(this.group);
    const texture = createDropTexture();
    for (let i = 0; i < MAX_DROPS; i++) {
      const mesh = new Mesh(
        new PlaneGeometry(1, 1),
        new MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
      );
      mesh.visible = false;
      mesh.renderOrder = 50;
      this.group.add(mesh);
      this.drops.push({ mesh, age: LIFETIME });
    }
  }

  setColor(color: Color): void {
    for (const d of this.drops) d.mesh.material.color.copy(color).multiplyScalar(2.2);
  }

  /** Returns true (absorbed) if the droplet reached the visor. */
  hit(point: Vector3, velocity: Vector3, camera: Camera): boolean {
    _local.copy(point);
    camera.worldToLocal(_local);
    if (_local.z > 0 || _local.length() > RANGE) return false;
    // Must be moving towards the eyes.
    if (velocity.dot(camera.getWorldDirection(new Vector3())) > 0) return false;
    const drop = this.drops.reduce((oldest, d) => (d.age > oldest.age ? d : oldest), this.drops[0]);
    drop.age = 0;
    const size = 0.008 + Math.random() * 0.014;
    drop.mesh.scale.set(size, size, 1);
    drop.mesh.position.set(
      Math.max(-0.05, Math.min(0.05, _local.x * 0.5)) + (Math.random() - 0.5) * 0.02,
      Math.max(-0.035, Math.min(0.035, _local.y * 0.5)) + (Math.random() - 0.5) * 0.02,
      -0.11,
    );
    drop.mesh.rotation.z = Math.random() * Math.PI * 2;
    drop.mesh.visible = true;
    return true;
  }

  update(dt: number): void {
    for (const d of this.drops) {
      if (!d.mesh.visible) continue;
      d.age += dt;
      d.mesh.material.opacity = Math.max(0, 1 - d.age / LIFETIME) * 0.85;
      // Slowly runs down.
      d.mesh.position.y -= dt * 0.002;
      if (d.age >= LIFETIME) d.mesh.visible = false;
    }
  }

  clear(): void {
    for (const d of this.drops) {
      d.age = LIFETIME;
      d.mesh.visible = false;
    }
  }
}

function createDropTexture(): CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.8)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}
