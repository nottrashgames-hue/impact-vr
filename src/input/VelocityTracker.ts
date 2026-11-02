import { Vector3 } from 'three';

/**
 * Smoothed world-space linear velocity from a ring buffer of recent positions
 * (Section 4: "Do NOT rely on physics engine velocity for kinematic bodies").
 *
 * Velocity is the least-squares slope of position over time across the window,
 * which is far less noisy than a two-sample difference and needs no filtering
 * lag tuning. Allocation-free after construction.
 */
export class VelocityTracker {
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;
  private readonly pt: Float64Array;
  private head = 0;
  private count = 0;
  /** Latest smoothed velocity in m/s. */
  readonly velocity = new Vector3();

  constructor(private readonly capacity = 6) {
    this.px = new Float64Array(capacity);
    this.py = new Float64Array(capacity);
    this.pz = new Float64Array(capacity);
    this.pt = new Float64Array(capacity);
  }

  /** Current speed in m/s. */
  get speed(): number {
    return this.velocity.length();
  }

  /** Drops history (e.g. when tracking is lost or the rig teleports). */
  reset(): void {
    this.count = 0;
    this.head = 0;
    this.velocity.set(0, 0, 0);
  }

  /** Adds a sample. `time` is in seconds and must be monotonic. */
  push(position: Vector3, time: number): void {
    const i = this.head;
    this.px[i] = position.x;
    this.py[i] = position.y;
    this.pz[i] = position.z;
    this.pt[i] = time;
    this.head = (i + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    this.solve();
  }

  private solve(): void {
    const n = this.count;
    if (n < 2) {
      this.velocity.set(0, 0, 0);
      return;
    }
    let tMean = 0;
    let xMean = 0;
    let yMean = 0;
    let zMean = 0;
    for (let k = 0; k < n; k++) {
      tMean += this.pt[k];
      xMean += this.px[k];
      yMean += this.py[k];
      zMean += this.pz[k];
    }
    tMean /= n;
    xMean /= n;
    yMean /= n;
    zMean /= n;

    let stt = 0;
    let stx = 0;
    let sty = 0;
    let stz = 0;
    for (let k = 0; k < n; k++) {
      const dt = this.pt[k] - tMean;
      stt += dt * dt;
      stx += dt * (this.px[k] - xMean);
      sty += dt * (this.py[k] - yMean);
      stz += dt * (this.pz[k] - zMean);
    }
    if (stt < 1e-12) return; // duplicate timestamps; keep the previous estimate
    this.velocity.set(stx / stt, sty / stt, stz / stt);
  }
}
