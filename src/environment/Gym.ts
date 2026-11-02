import {
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  type Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RING, ROOM } from '../config';
import { smoothstep } from '../core/mathUtils';
import type { Physics } from '../core/Physics';
import type { QualityPreset } from '../core/Quality';
import { createLighting, type GymLights } from './Lighting';
import { MeshBatcher } from './MeshBatcher';
import {
  createBannerAtlasTexture,
  createBlockWallTexture,
  createLeatherTexture,
  createLockerTexture,
  createPaddingTexture,
  createRingCanvasTexture,
  createRubberTileTexture,
  createSkirtTexture,
} from './textures';

const FLOOR_Y = -RING.platformHeight; // gym floor height
const CEILING_Y = FLOOR_Y + ROOM.height;
const POST = RING.ropeHalfExtent + 0.06; // corner post centres (±POST, ±POST)
const HALF_PI = Math.PI / 2;

type Materials = ReturnType<typeof createMaterials>;

/**
 * The boxing gym (Section 2): a raised ring whose canvas top is the player's
 * floor (y = 0), surrounded by a padded training room.
 *
 * Everything static is merged per material by {@link MeshBatcher} with lighting
 * baked into vertex colours, so the room costs ~12 draw calls. The ring canvas
 * is a separate single plane with 0..1 UVs across its full extent; the floor
 * blood accumulation map (Milestone 7) is layered onto its material.
 */
export class Gym {
  readonly root = new Group();
  /** The ring canvas plane. UV (0,0) is the (-x, +z) corner; see {@link worldToFloorUV}. */
  readonly floor: Mesh<PlaneGeometry, MeshStandardMaterial>;
  readonly lights: GymLights;

  constructor(scene: Scene, renderer: WebGLRenderer, quality: QualityPreset) {
    this.root.name = 'gym';
    const anisotropy = Math.min(quality.maxAnisotropy, renderer.capabilities.getMaxAnisotropy());
    const materials = createMaterials(anisotropy);

    this.floor = createRingFloor(quality, anisotropy);
    this.root.add(this.floor);

    const batch = new MeshBatcher(bakeGymLight);
    buildRing(batch, materials);
    buildRoom(batch, materials);
    buildProps(batch, materials);
    for (const mesh of batch.build()) this.root.add(mesh);

    scene.add(this.root);
    this.lights = createLighting(scene, renderer, quality);
  }

  /** Static colliders: the ring platform (top face = canvas at y = 0) and the gym floor. */
  addColliders(physics: Physics): void {
    const half = RING.floorSize / 2;
    physics.addStaticBox(0, FLOOR_Y / 2, 0, half, -FLOOR_Y / 2, half);
    physics.addStaticBox(0, FLOOR_Y - 0.05, 0, ROOM.width / 2, 0.05, ROOM.depth / 2);
  }

  /**
   * Maps a world-space point on the canvas to floor UV.
   * u grows along +X, v grows along -Z (PlaneGeometry rotated -90° about X).
   * @returns false if the point is outside the canvas.
   */
  worldToFloorUV(x: number, z: number, out: Vector2): boolean {
    out.set(0.5 + x / RING.floorSize, 0.5 - z / RING.floorSize);
    return out.x >= 0 && out.x <= 1 && out.y >= 0 && out.y <= 1;
  }
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

function createMaterials(anisotropy: number) {
  return {
    rubber: new MeshLambertMaterial({ name: 'rubber', map: createRubberTileTexture(anisotropy), vertexColors: true }),
    wall: new MeshLambertMaterial({ name: 'wall', map: createBlockWallTexture(anisotropy), vertexColors: true }),
    /** Untextured surfaces; colour comes entirely from per-piece tints. */
    plain: new MeshLambertMaterial({ name: 'plain', vertexColors: true }),
    pad: new MeshLambertMaterial({ name: 'pad', map: createPaddingTexture(anisotropy), vertexColors: true }),
    skirt: new MeshLambertMaterial({ name: 'skirt', map: createSkirtTexture(anisotropy), vertexColors: true }),
    banner: new MeshLambertMaterial({ name: 'banner', map: createBannerAtlasTexture(anisotropy), vertexColors: true }),
    locker: new MeshLambertMaterial({ name: 'locker', map: createLockerTexture(anisotropy), vertexColors: true }),
    leather: new MeshLambertMaterial({ name: 'leather', map: createLeatherTexture(anisotropy), vertexColors: true }),
    metal: new MeshStandardMaterial({ name: 'metal', metalness: 0.85, roughness: 0.32, vertexColors: true }),
    rope: new MeshStandardMaterial({ name: 'rope', metalness: 0, roughness: 0.5, vertexColors: true }),
    /** Light panels, lamps and windows: unlit, brightness from tint (may exceed 1). */
    emissive: new MeshBasicMaterial({ name: 'emissive', vertexColors: true }),
  };
}

function createRingFloor(quality: QualityPreset, anisotropy: number): Mesh<PlaneGeometry, MeshStandardMaterial> {
  const outsideRopes = (RING.floorSize / 2 - RING.ropeHalfExtent) / RING.floorSize;
  const textureSize = quality.level === 'pc' ? 2048 : 1024;
  const material = new MeshStandardMaterial({
    name: 'ring-canvas',
    map: createRingCanvasTexture(textureSize, outsideRopes, anisotropy),
    roughness: 0.92,
    metalness: 0,
  });
  const floor = new Mesh(new PlaneGeometry(RING.floorSize, RING.floorSize), material);
  floor.name = 'ring-canvas';
  floor.rotation.x = -HALF_PI;
  floor.receiveShadow = true;
  // Draw before the room so early-Z rejects the gym floor hidden beneath the ring.
  floor.renderOrder = -1;
  floor.updateMatrix();
  floor.matrixAutoUpdate = false;
  return floor;
}

// ---------------------------------------------------------------------------
// Baked lighting
// ---------------------------------------------------------------------------

/**
 * Fake baked light: a pool of light under the ring rig fading towards the walls,
 * plus ambient occlusion near the gym floor, room corners and ceiling.
 */
function bakeGymLight(p: Vector3, n: Vector3): number {
  const heightAboveFloor = p.y - FLOOR_Y;
  const aoFloor = 0.55 + 0.45 * smoothstep(0, 1.4, heightAboveFloor);
  const toWallX = ROOM.width / 2 - Math.abs(p.x);
  const toWallZ = ROOM.depth / 2 - Math.abs(p.z);
  const aoCorner = 0.65 + 0.35 * smoothstep(0, 3, Math.max(toWallX, toWallZ));
  const aoCeiling = 0.6 + 0.4 * smoothstep(0, 1.2, CEILING_Y - p.y);

  const distSq = p.x * p.x + p.z * p.z;
  const pool = Math.exp(-distSq / (2 * 4.5 * 4.5));
  const facingUp = 0.5 + 0.5 * n.y;
  const light = 0.5 + 0.7 * pool * (0.55 + 0.45 * facingUp);

  return aoFloor * aoCorner * aoCeiling * light;
}

// ---------------------------------------------------------------------------
// Ring
// ---------------------------------------------------------------------------

function buildRing(batch: MeshBatcher, m: Materials): void {
  const edge = RING.floorSize / 2;
  const navy = 0x16213d;

  // Padded bumper around the canvas edge (hides the plane's edge).
  for (const s of [-1, 1]) {
    batch.add(m.plain, new BoxGeometry(RING.floorSize + 0.16, 0.09, 0.08), {
      position: [0, -0.035, s * (edge + 0.04)],
      tint: navy,
    });
    batch.add(m.plain, new BoxGeometry(0.08, 0.09, RING.floorSize + 0.16), {
      position: [s * (edge + 0.04), -0.035, 0],
      tint: navy,
    });
  }

  // Skirt hanging from the apron to the gym floor.
  const skirtHeight = RING.platformHeight - 0.08;
  const skirtY = -0.08 - skirtHeight / 2;
  const skirtDist = edge + 0.075;
  const skirtSides: ReadonlyArray<readonly [number, number, number]> = [
    [0, skirtDist, 0],
    [0, -skirtDist, Math.PI],
    [skirtDist, 0, HALF_PI],
    [-skirtDist, 0, -HALF_PI],
  ];
  for (const [x, z, ry] of skirtSides) {
    batch.add(m.skirt, new PlaneGeometry(RING.floorSize + 0.16, skirtHeight, 8, 4), {
      position: [x, skirtY, z],
      rotation: [0, ry, 0],
      uvScale: [2, 1],
    });
  }

  // Corner posts (from the gym floor up through the apron) with ball caps.
  const postLength = RING.postHeight - FLOOR_Y;
  // Corner pads: red corner and blue corner diagonally opposite, two neutral.
  const padTint = (sx: number, sz: number): number => {
    if (sx < 0 && sz < 0) return 0xb3171b;
    if (sx > 0 && sz > 0) return 0x1d3f8f;
    return 0xe2e2e2;
  };
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      batch.add(m.metal, new CylinderGeometry(0.055, 0.055, postLength, 16), {
        position: [sx * POST, FLOOR_Y + postLength / 2, sz * POST],
        tint: 0x9aa1aa,
      });
      batch.add(m.metal, new SphereGeometry(0.065, 14, 10), {
        position: [sx * POST, RING.postHeight, sz * POST],
        tint: 0x9aa1aa,
      });
      batch.add(m.pad, new RoundedBoxGeometry(0.2, 1.22, 0.2, 2, 0.05), {
        position: [sx * (POST - 0.1), 0.96, sz * (POST - 0.1)],
        rotation: [0, Math.PI / 4, 0],
        tint: padTint(sx, sz),
      });
    }
  }

  // Ropes: four tiers on each side, bottom to top.
  const ropeTints = [0x1d3f8f, 0xe8e8e8, 0xe8e8e8, 0xb3171b];
  const R = RING.ropeHalfExtent;
  RING.ropeHeights.forEach((h, i) => {
    for (const s of [-1, 1]) {
      batch.add(m.rope, new CylinderGeometry(0.021, 0.021, 2 * POST, 10), {
        position: [0, h, s * R],
        rotation: [0, 0, HALF_PI],
        tint: ropeTints[i],
      });
      batch.add(m.rope, new CylinderGeometry(0.021, 0.021, 2 * POST, 10), {
        position: [s * R, h, 0],
        rotation: [HALF_PI, 0, 0],
        tint: ropeTints[i],
      });
    }
  });

  // Vertical rope ties at the thirds of each side.
  const tieHeight = RING.ropeHeights[3] - RING.ropeHeights[0] + 0.06;
  const tieY = (RING.ropeHeights[0] + RING.ropeHeights[3]) / 2;
  for (const s of [-1, 1]) {
    for (const t of [-1, 1]) {
      batch.add(m.plain, new BoxGeometry(0.035, tieHeight, 0.05), { position: [t, tieY, s * R], tint: 0xf0f0f0 });
      batch.add(m.plain, new BoxGeometry(0.05, tieHeight, 0.035), { position: [s * R, tieY, t], tint: 0xf0f0f0 });
    }
  }

  // Steps up to the apron on the +X side.
  for (let i = 0; i < 3; i++) {
    const h = ((i + 1) * RING.platformHeight) / 3.4;
    batch.add(m.plain, new BoxGeometry(0.4, h, 1.0), {
      position: [edge + 0.32 + (2 - i) * 0.4, FLOOR_Y + h / 2, 2.2],
      tint: 0x2a2f3a,
    });
  }

  buildLightingRig(batch, m);
}

/** Square truss over the ring with four angled light panels. */
function buildLightingRig(batch: MeshBatcher, m: Materials): void {
  const T = 2.6;
  const y = 3.55;
  const steel = 0x22252b;

  for (const s of [-1, 1]) {
    batch.add(m.plain, new BoxGeometry(2 * T + 0.12, 0.12, 0.12), { position: [0, y, s * T], tint: steel });
    batch.add(m.plain, new BoxGeometry(0.12, 0.12, 2 * T), { position: [s * T, y, 0], tint: steel });
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      batch.add(m.plain, new CylinderGeometry(0.01, 0.01, CEILING_Y - y, 6), {
        position: [sx * T, (y + CEILING_Y) / 2, sz * T],
        tint: 0x111111,
      });
    }
  }

  // Panels hang under each truss side, tilted towards the ring centre.
  const tilt = 0.55;
  const panelColor = new Color(1.7, 1.55, 1.35);
  const offset = new Vector3();
  for (const yaw of [0, Math.PI, HALF_PI, -HALF_PI]) {
    offset.set(0, y - 0.14, T).applyAxisAngle(new Vector3(0, 1, 0), yaw);
    const housing = new BoxGeometry(1.4, 0.08, 0.46).rotateX(tilt);
    batch.add(m.plain, housing, { position: [offset.x, offset.y, offset.z], rotation: [0, yaw, 0], tint: 0x181a1f });
    // Emissive face sits just below the housing along its tilted normal.
    const face = new PlaneGeometry(1.3, 0.38).rotateX(HALF_PI + tilt).translate(0, -0.042 * Math.cos(tilt), -0.042 * Math.sin(tilt));
    batch.add(m.emissive, face, {
      position: [offset.x, offset.y, offset.z],
      rotation: [0, yaw, 0],
      tint: panelColor,
      bake: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Room shell
// ---------------------------------------------------------------------------

function buildRoom(batch: MeshBatcher, m: Materials): void {
  const W = ROOM.width;
  const D = ROOM.depth;
  const H = ROOM.height;

  batch.add(m.rubber, new PlaneGeometry(W, D, 40, 40), {
    position: [0, FLOOR_Y, 0],
    rotation: [-HALF_PI, 0, 0],
    uvScale: [W, D],
  });

  const walls: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, -D / 2, 0, W], // back (behind the opponent)
    [0, D / 2, Math.PI, W], // front (behind the player)
    [-W / 2, 0, HALF_PI, D], // left
    [W / 2, 0, -HALF_PI, D], // right
  ];
  for (const [x, z, ry, length] of walls) {
    batch.add(m.wall, new PlaneGeometry(length, H, 24, 8), {
      position: [x, FLOOR_Y + H / 2, z],
      rotation: [0, ry, 0],
      uvScale: [length / 1.6, H / 1.6],
    });
  }

  batch.add(m.plain, new PlaneGeometry(W, D, 12, 12), {
    position: [0, CEILING_Y, 0],
    rotation: [HALF_PI, 0, 0],
    tint: 0x2c3036,
  });
  for (let z = -8; z <= 8; z += 4) {
    batch.add(m.plain, new BoxGeometry(W, 0.35, 0.22, 12, 1, 1), {
      position: [0, CEILING_Y - 0.18, z],
      tint: 0x3a3f47,
    });
  }

  // Wall padding (1.6 m tall) on the left, back and front walls.
  const padH = 1.6;
  const padY = FLOOR_Y + 0.05 + padH / 2;
  const padRed = 0x8c1d22;
  batch.add(m.pad, new BoxGeometry(0.1, padH, D - 0.4, 1, 1, 16), {
    position: [-W / 2 + 0.06, padY, 0],
    uvScale: [(D - 0.4) / 1.2, 1],
    tint: padRed,
  });
  batch.add(m.pad, new BoxGeometry(W - 0.4, padH, 0.1, 16, 1, 1), {
    position: [0, padY, -D / 2 + 0.06],
    uvScale: [(W - 0.4) / 1.2, 1],
    tint: padRed,
  });
  // Front wall pads leave a gap for the door at x = -6.
  const frontSegments: ReadonlyArray<readonly [number, number]> = [
    [-W / 2 + 0.2, -6.8],
    [-5.2, W / 2 - 0.2],
  ];
  for (const [x0, x1] of frontSegments) {
    const len = x1 - x0;
    batch.add(m.pad, new BoxGeometry(len, padH, 0.1, 8, 1, 1), {
      position: [(x0 + x1) / 2, padY, D / 2 - 0.06],
      uvScale: [len / 1.2, 1],
      tint: padRed,
    });
  }
  batch.add(m.plain, new BoxGeometry(1.3, 2.3, 0.08), {
    position: [-6, FLOOR_Y + 1.15, D / 2 - 0.04],
    tint: 0x3b3430,
  });

  // High windows (unlit daylight) on the back and right walls.
  const daylight = new Color(0.95, 1.08, 1.3);
  const frame = 0x1c1f24;
  const winY = FLOOR_Y + 4.3;
  const winW = 2.6;
  const winH = 1.4;
  for (const c of [-6, -2, 2, 6]) {
    // Back wall: window centred at x = c.
    addWindow(batch, m, [c, winY, -D / 2 + 0.03], 0, winW, winH, daylight, frame);
    // Right wall: window centred at z = c.
    addWindow(batch, m, [W / 2 - 0.03, winY, c], -HALF_PI, winW, winH, daylight, frame);
  }
}

function addWindow(
  batch: MeshBatcher,
  m: Materials,
  position: readonly [number, number, number],
  yaw: number,
  w: number,
  h: number,
  glow: Color,
  frame: number,
): void {
  const rotation = [0, yaw, 0] as const;
  batch.add(m.emissive, new PlaneGeometry(w, h), { position, rotation, tint: glow, bake: false });
  // Frame bars are built in the window's local space, then rotated with it.
  const bars: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, h / 2, w + 0.1, 0.08], // top
    [0, -h / 2, w + 0.1, 0.08], // bottom
    [0, 0, w, 0.05], // transom
  ];
  for (const [bx, by, bw, bh] of bars) {
    batch.add(m.plain, new BoxGeometry(bw, bh, 0.06).translate(bx, by, 0.02), { position, rotation, tint: frame });
  }
  for (const bx of [-w / 2, 0, w / 2]) {
    batch.add(m.plain, new BoxGeometry(0.07, h, 0.06).translate(bx, 0, 0.02), { position, rotation, tint: frame });
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

function buildProps(batch: MeshBatcher, m: Materials): void {
  const W = ROOM.width;
  const D = ROOM.depth;

  // Heavy bags along the left wall, hanging from the ceiling.
  const bagX = -7.6;
  const bagY = 0.35;
  const bagH = 1.15;
  for (const z of [-5.5, -2.5, 0.5, 3.5]) {
    batch.add(m.leather, new CylinderGeometry(0.19, 0.19, bagH, 20, 1, true), { position: [bagX, bagY, z] });
    for (const s of [-1, 1]) {
      batch.add(m.plain, new CylinderGeometry(0.19, 0.19, 0.04, 20), {
        position: [bagX, bagY + s * (bagH / 2 + 0.02), z],
        tint: 0x151515,
      });
    }
    const top = bagY + bagH / 2 + 0.04;
    batch.add(m.plain, new CylinderGeometry(0.012, 0.012, CEILING_Y - top, 6), {
      position: [bagX, (top + CEILING_Y) / 2, z],
      tint: 0x55595f,
    });
  }

  // Lockers on the right wall, doors facing into the room.
  for (let i = 0; i < 8; i++) {
    const shade = new Color(0xffffff).multiplyScalar(0.92 + (i % 3) * 0.04);
    batch.add(m.locker, new BoxGeometry(0.5, 1.9, 0.46), {
      position: [W / 2 - 0.28, FLOOR_Y + 0.95, -7.6 + i * 0.48],
      tint: shade,
    });
  }

  // Benches: in front of the lockers and along the back wall.
  const wood = 0x8a5a35;
  const steel = 0x2a2d33;
  addBench(batch, m, [W / 2 - 1.3, -5.9], HALF_PI, wood, steel);
  addBench(batch, m, [-5.8, -D / 2 + 0.7], 0, wood, steel);

  // Banners flanking the opponent on the back wall (atlas: left half / right half).
  const bannerZ = -D / 2 + 0.13;
  batch.add(m.banner, new PlaneGeometry(0.95, 1.9, 1, 4), {
    position: [-1.9, FLOOR_Y + 2.75, bannerZ],
    uvScale: [0.5, 1],
  });
  batch.add(m.banner, new PlaneGeometry(0.95, 1.9, 1, 4), {
    position: [1.9, FLOOR_Y + 2.75, bannerZ],
    uvScale: [0.5, 1],
    uvOffset: [0.5, 0],
  });

  // Pendant lamps over the rest of the gym (unlit bulbs, no real lights).
  const lampY = 3.7;
  const warm = new Color(1.8, 1.5, 1.1);
  const lamps: ReadonlyArray<readonly [number, number]> = [
    [-6, -6],
    [-6, 3],
    [6, -6],
    [6, 3],
    [0, -7.5],
    [0, 7],
  ];
  for (const [x, z] of lamps) {
    batch.add(m.plain, new CylinderGeometry(0.07, 0.36, 0.28, 16), { position: [x, lampY, z], tint: 0x23262c });
    batch.add(m.emissive, new CircleGeometry(0.32, 20).rotateX(HALF_PI), {
      position: [x, lampY - 0.145, z],
      tint: warm,
      bake: false,
    });
    batch.add(m.plain, new CylinderGeometry(0.008, 0.008, CEILING_Y - lampY - 0.14, 5), {
      position: [x, (lampY + 0.14 + CEILING_Y) / 2, z],
      tint: 0x111111,
    });
  }
}

function addBench(
  batch: MeshBatcher,
  m: Materials,
  [x, z]: readonly [number, number],
  yaw: number,
  wood: number,
  steel: number,
): void {
  const rotation = [0, yaw, 0] as const;
  const position = [x, FLOOR_Y, z] as const;
  batch.add(m.plain, new BoxGeometry(2.4, 0.06, 0.4).translate(0, 0.45, 0), { position, rotation, tint: wood });
  for (const lx of [-1.0, 1.0]) {
    batch.add(m.plain, new BoxGeometry(0.06, 0.42, 0.36).translate(lx, 0.21, 0), { position, rotation, tint: steel });
  }
}
