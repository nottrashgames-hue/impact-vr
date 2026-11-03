import { KNOCKOUT, URL_FLAGS } from '../config';
import type { GloveColor, GloveWeight } from '../player/GearProfile';
import { detectQualityLevel, isQualityLevel, type QualityLevel } from './Quality';

export type BloodLevel = 'off' | 'low' | 'medium' | 'high';
export type BloodColor = 'red' | 'green' | 'off';
export type OpponentMode = 'passive' | 'defensive' | 'sparring';

/** Every player-facing option (Section 10). */
export interface Settings {
  blood: BloodLevel;
  bruising: boolean;
  bloodColor: BloodColor;
  quality: QualityLevel;
  /** Multipliers on drying and bruise-development speed (sliders). */
  dryingSpeed: number;
  bruiseSpeed: number;
  /** Tiny droplets on the player's "visor" (off by default). */
  visorSplatter: boolean;
  /** Slow regeneration of swelling and bleeding (Section 8.6). */
  healing: boolean;
  koRecovery: 'prompt' | 'getUp';
  glovesOn: boolean;
  gloveColor: GloveColor;
  gloveWeight: GloveWeight;
  opponentMode: OpponentMode;
  /** VR: metres added to the player's tracked height ("Match height" calibration). */
  heightOffset: number;
  /** VR: smooth turning with the right stick instead of 30° snap turns. */
  smoothTurn: boolean;
  showHud: boolean;
  showHitboxes: boolean;
  showRenderTargets: boolean;
  showStats: boolean;
}

const STORAGE_KEY = 'impact.settings.v1';

function defaults(): Settings {
  return {
    blood: 'high',
    bruising: true,
    bloodColor: 'red',
    quality: isQualityLevel(URL_FLAGS.quality) ? URL_FLAGS.quality : detectQualityLevel(),
    dryingSpeed: 1,
    bruiseSpeed: 1,
    visorSplatter: false,
    healing: false,
    koRecovery: KNOCKOUT.recovery,
    glovesOn: false,
    gloveColor: 'red',
    gloveWeight: 12,
    opponentMode: 'sparring',
    heightOffset: 0,
    smoothTurn: false,
    showHud: URL_FLAGS.debug,
    showHitboxes: false,
    showRenderTargets: false,
    showStats: false,
  };
}

/** Blood amount multiplier for each level (0 disables all blood). */
export function bloodScale(settings: Settings): number {
  if (settings.bloodColor === 'off') return 0;
  return { off: 0, low: 0.35, medium: 0.7, high: 1 }[settings.blood];
}

type Listener = (settings: Readonly<Settings>, changed: ReadonlySet<keyof Settings>) => void;

/**
 * Observable settings store, persisted per browser in localStorage (a viewer
 * convenience: storage may be unavailable, so every access is guarded and the
 * game falls back to defaults). URL flags still win for quality and debug.
 */
export class SettingsStore {
  private readonly value: Settings;
  private readonly listeners: Listener[] = [];

  constructor() {
    this.value = { ...defaults(), ...this.load() };
    // One-off: since the combat update the opponent fights back, even for players who saved another mode.
    if (this.firstRunOf('impact.migrated.fightBack')) {
      this.value.opponentMode = 'sparring';
      this.save();
    }
    if (isQualityLevel(URL_FLAGS.quality)) this.value.quality = URL_FLAGS.quality;
  }

  get current(): Readonly<Settings> {
    return this.value;
  }

  /** Applies a partial update, notifies listeners and persists. */
  set(patch: Partial<Settings>): void {
    const changed = new Set<keyof Settings>();
    for (const key of Object.keys(patch) as (keyof Settings)[]) {
      if (patch[key] !== undefined && patch[key] !== this.value[key]) {
        (this.value as unknown as Record<string, unknown>)[key] = patch[key];
        changed.add(key);
      }
    }
    if (changed.size === 0) return;
    this.save();
    for (const listener of this.listeners) listener(this.value, changed);
  }

  /** Calls `listener` now with every key "changed", then on each change. */
  subscribe(listener: Listener): void {
    this.listeners.push(listener);
    listener(this.value, new Set(Object.keys(this.value) as (keyof Settings)[]));
  }

  private load(): Partial<Settings> {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      const base = defaults();
      const result: Partial<Settings> = {};
      // Only accept known keys with the right primitive type.
      for (const key of Object.keys(base) as (keyof Settings)[]) {
        const v = (parsed as Record<string, unknown>)[key];
        if (v !== undefined && typeof v === typeof base[key]) (result as Record<string, unknown>)[key] = v;
      }
      return result;
    } catch {
      return {};
    }
  }

  /** True the first time `key` is seen in this browser (false if storage is unavailable). */
  private firstRunOf(key: string): boolean {
    try {
      if (window.localStorage.getItem(key)) return false;
      window.localStorage.setItem(key, '1');
      return true;
    } catch {
      return false;
    }
  }

  private save(): void {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.value));
    } catch {
      // Storage blocked (private window, previews): settings just won't persist.
    }
  }
}
