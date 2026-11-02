/**
 * Quality presets (Section 11). Auto-selected from the user agent, overridable
 * via `?quality=quest2|quest3|pc` (and later from the settings menu).
 */

export type QualityLevel = 'quest2' | 'quest3' | 'pc';

export interface QualityPreset {
  readonly level: QualityLevel;
  readonly label: string;
  /** WebXR framebuffer scale factor (1 = the runtime's recommended resolution). */
  readonly framebufferScale: number;
  /** Fixed foveated rendering level, 0 (off) .. 1 (max). */
  readonly foveation: number;
  /** Preferred headset refresh rate in Hz; applied only if the runtime supports it. */
  readonly targetFrameRate: number;
  /** Resolution of the key light's shadow map. */
  readonly shadowMapSize: number;
  /** Anisotropic filtering cap for floor/wall textures. */
  readonly maxAnisotropy: number;
  /** Device pixel ratio cap for the desktop (non-XR) canvas. */
  readonly pixelRatioCap: number;
  /** Hard cap on live blood droplet particles (Section 7.1). */
  readonly maxParticles: number;
  /** Floor blood accumulation render-target resolution (Section 7.3). */
  readonly floorBloodMapSize: number;
  /** Opponent skin damage / blood paint render-target resolution (Sections 7.4, 8.1). */
  readonly skinPaintSize: number;
}

export const QUALITY_PRESETS: Readonly<Record<QualityLevel, QualityPreset>> = {
  quest2: {
    level: 'quest2',
    label: 'Quest 2',
    framebufferScale: 1.0,
    foveation: 1,
    targetFrameRate: 72,
    shadowMapSize: 1024,
    maxAnisotropy: 4,
    pixelRatioCap: 1,
    maxParticles: 400,
    floorBloodMapSize: 2048,
    skinPaintSize: 1024,
  },
  quest3: {
    level: 'quest3',
    label: 'Quest 3',
    framebufferScale: 1.0,
    foveation: 1,
    targetFrameRate: 90,
    shadowMapSize: 2048,
    maxAnisotropy: 8,
    pixelRatioCap: 1,
    maxParticles: 700,
    floorBloodMapSize: 2048,
    skinPaintSize: 1024,
  },
  pc: {
    level: 'pc',
    label: 'PC',
    framebufferScale: 1.0,
    foveation: 1,
    targetFrameRate: 90,
    shadowMapSize: 2048,
    maxAnisotropy: 16,
    pixelRatioCap: 2,
    maxParticles: 1500,
    floorBloodMapSize: 4096,
    skinPaintSize: 2048,
  },
};

/** Picks a preset from the user agent. Quest Browser reports e.g. "Quest 3" / "Quest 2". */
export function detectQualityLevel(userAgent: string = navigator.userAgent): QualityLevel {
  if (/Quest 3/i.test(userAgent)) return 'quest3'; // also matches "Quest 3S"
  if (/Quest|OculusBrowser|Pacific/i.test(userAgent)) return 'quest2'; // Quest 2 / Pro / older
  return 'pc';
}

export function isQualityLevel(value: string | null): value is QualityLevel {
  return value === 'quest2' || value === 'quest3' || value === 'pc';
}

/** Resolves the active preset: explicit override first, then device detection. */
export function resolveQuality(override: string | null): QualityPreset {
  const level = isQualityLevel(override) ? override : detectQualityLevel();
  return QUALITY_PRESETS[level];
}
