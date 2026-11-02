import type { WebGLRenderer } from 'three';

export interface LoopCallbacks {
  /** Runs at a fixed rate (physics, simulation). */
  fixedUpdate(dt: number): void;
  /**
   * Runs once per rendered frame.
   * @param dt     variable frame delta in seconds (clamped)
   * @param alpha  0..1 progress between the last two fixed steps, for interpolation
   * @param frame  the current XRFrame when presenting in VR
   */
  update(dt: number, alpha: number, frame: XRFrame | undefined): void;
  render(): void;
}

/**
 * Fixed-timestep game loop driven by `renderer.setAnimationLoop`, which uses the
 * XR session's frame callback while in VR and requestAnimationFrame otherwise.
 *
 * Simulation runs in fixed steps (accumulator pattern) with a substep cap, so a
 * slow frame never spirals into an ever-growing physics backlog.
 */
export class GameLoop {
  private accumulator = 0;
  private lastTime = -1;
  private _time = 0;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly callbacks: LoopCallbacks,
    readonly fixedStep: number,
    private readonly maxSubSteps: number,
  ) {}

  /** Total simulated time in seconds. */
  get time(): number {
    return this._time;
  }

  /** Timestamp of the current frame in seconds (raw, for velocity sampling). */
  get frameTime(): number {
    return Math.max(0, this.lastTime);
  }

  start(): void {
    this.renderer.setAnimationLoop(this.tick);
  }

  stop(): void {
    this.renderer.setAnimationLoop(null);
  }

  /**
   * Forget the previous frame timestamp. Call when switching between the desktop
   * and XR frame loops, whose timestamps are not guaranteed to be continuous.
   */
  resetClock(): void {
    this.lastTime = -1;
  }

  private readonly tick = (timestamp: number, frame?: XRFrame): void => {
    const now = timestamp / 1000;
    // Clamp long gaps (tab switch, headset removed) so we don't fast-forward.
    const dt = this.lastTime < 0 ? 0 : Math.min(now - this.lastTime, 0.1);
    this.lastTime = now;

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < this.maxSubSteps) {
      this.callbacks.fixedUpdate(this.fixedStep);
      this.accumulator -= this.fixedStep;
      this._time += this.fixedStep;
      steps++;
    }
    // Drop any remaining backlog rather than carrying it into the next frame.
    if (steps === this.maxSubSteps) {
      this.accumulator = Math.min(this.accumulator, this.fixedStep);
    }

    const alpha = this.accumulator / this.fixedStep;
    this.callbacks.update(dt, alpha, frame);
    this.callbacks.render();
  };
}
