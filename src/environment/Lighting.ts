import {
  DirectionalLight,
  HemisphereLight,
  Object3D,
  PMREMGenerator,
  type Scene,
  SpotLight,
  type WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { WORLD } from '../config';
import type { QualityPreset } from '../core/Quality';

export interface GymLights {
  /** The only real-time shadow caster: overhead key light aimed at the opponent. */
  readonly key: SpotLight;
  readonly hemisphere: HemisphereLight;
  readonly rim: DirectionalLight;
}

/**
 * Lighting rig (Section 2). Most of the room's look comes from vertex-baked
 * light in the static meshes; at runtime there is:
 *  - one hemisphere light (cheap ambient),
 *  - one shadow-casting spot light over the ring (the character's key light),
 *  - one shadowless rim light from behind the opponent for separation,
 *  - a prefiltered room environment map for reflections on PBR materials.
 */
export function createLighting(scene: Scene, renderer: WebGLRenderer, quality: QualityPreset): GymLights {
  // Ground colour approximates bounce light off the pale ring canvas, which
  // keeps undersides (nose, chin, brow) from going black.
  const hemisphere = new HemisphereLight(0xdde6ff, 0x6a645e, 1.0);
  scene.add(hemisphere);

  const target = new Object3D();
  target.position.set(WORLD.opponentX, 0.9, WORLD.opponentZ);
  scene.add(target);

  // Above and slightly in front of the opponent so their face is lit from the
  // player's side and the shadow falls behind them onto the canvas.
  const key = new SpotLight(0xfff1dc, 42, 12, 0.6, 0.6, 2);
  key.position.set(0.7, 3.4, 1.4);
  key.target = target;
  key.castShadow = true;
  key.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 7;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key);

  const rim = new DirectionalLight(0xbcd0ff, 0.9);
  rim.position.set(-3, 4, -6);
  rim.target = target;
  scene.add(rim);

  // Image-based lighting for PBR materials (canvas, ropes, posts, later skin and blood).
  const pmrem = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, 0.04).texture;
  scene.environmentIntensity = 0.3;
  room.dispose();
  pmrem.dispose();

  return { key, hemisphere, rim };
}
