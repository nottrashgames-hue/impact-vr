import type { WebGLRenderer } from 'three';
import type { QualityPreset } from './Quality';

export type XRSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string };

export interface XRSessionInfo {
  readonly session: XRSession;
  /** 'local-floor' when available; otherwise 'local' (the rig must add eye height). */
  readonly referenceSpaceType: 'local-floor' | 'local';
  readonly handTracking: boolean;
}

/**
 * Owns the immersive-vr session lifecycle (custom "Enter VR" flow instead of
 * three's VRButton so we control features, reference-space fallback, foveation,
 * framebuffer scale and refresh rate).
 */
export class XRSessionManager {
  private session: XRSession | null = null;
  private readonly startListeners: Array<(info: XRSessionInfo) => void> = [];
  private readonly endListeners: Array<() => void> = [];

  constructor(
    private readonly renderer: WebGLRenderer,
    private quality: QualityPreset,
  ) {}

  /** Foveation applies now; framebuffer scale and refresh rate on the next session. */
  setQuality(quality: QualityPreset): void {
    this.quality = quality;
    this.renderer.xr.setFoveation(quality.foveation);
  }

  get active(): boolean {
    return this.session !== null;
  }

  onSessionStart(listener: (info: XRSessionInfo) => void): void {
    this.startListeners.push(listener);
  }

  onSessionEnd(listener: () => void): void {
    this.endListeners.push(listener);
  }

  async checkSupport(): Promise<XRSupport> {
    if (!window.isSecureContext) {
      return { supported: false, reason: 'WebXR needs HTTPS (or localhost). Open the https:// URL.' };
    }
    if (!navigator.xr) {
      return { supported: false, reason: 'WebXR is not available in this browser. Desktop mode only.' };
    }
    try {
      const ok = await navigator.xr.isSessionSupported('immersive-vr');
      return ok
        ? { supported: true }
        : { supported: false, reason: 'No VR headset detected. Desktop mode only.' };
    } catch {
      return { supported: false, reason: 'VR support check was blocked by the browser.' };
    }
  }

  /** Requests and starts an immersive-vr session. Must be called from a user gesture. */
  async enter(): Promise<void> {
    if (this.session || !navigator.xr) return;

    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'],
    });

    // Prefer a floor-relative space; fall back to 'local' on runtimes without it.
    let referenceSpaceType: XRSessionInfo['referenceSpaceType'] = 'local-floor';
    try {
      await session.requestReferenceSpace('local-floor');
    } catch {
      referenceSpaceType = 'local';
    }

    const xr = this.renderer.xr;
    xr.setReferenceSpaceType(referenceSpaceType);
    xr.setFramebufferScaleFactor(this.quality.framebufferScale);
    xr.setFoveation(this.quality.foveation);
    await xr.setSession(session);
    // Foveation is applied to the session's layer once it exists; set again to be safe.
    xr.setFoveation(this.quality.foveation);

    await this.applyTargetFrameRate(session);

    this.session = session;
    session.addEventListener('end', this.handleEnd);

    const handTracking = session.enabledFeatures?.includes('hand-tracking') ?? true;
    const info: XRSessionInfo = { session, referenceSpaceType, handTracking };
    for (const listener of this.startListeners) listener(info);
  }

  async exit(): Promise<void> {
    await this.session?.end();
  }

  /** Asks the runtime for the preset's refresh rate (e.g. 90 Hz on Quest 3) if supported. */
  private async applyTargetFrameRate(session: XRSession): Promise<void> {
    const rates = session.supportedFrameRates;
    if (!rates || rates.length === 0) return;
    const target = this.quality.targetFrameRate;
    // Choose the highest supported rate that does not exceed the target.
    let best = 0;
    for (const rate of rates) {
      if (rate <= target && rate > best) best = rate;
    }
    if (best > 0 && session.frameRate !== best) {
      try {
        await session.updateTargetFrameRate(best);
      } catch {
        // Not fatal: the runtime keeps its default refresh rate.
      }
    }
  }

  private readonly handleEnd = (): void => {
    this.session?.removeEventListener('end', this.handleEnd);
    this.session = null;
    for (const listener of this.endListeners) listener();
  };
}
