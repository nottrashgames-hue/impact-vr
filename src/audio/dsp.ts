/**
 * Minimal offline DSP used to synthesise the game's sounds into AudioBuffers
 * at startup (no audio files needed).
 */

/** Seeded PRNG (mulberry32) so every variant is deterministic. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type FilterType = 'lowpass' | 'highpass' | 'bandpass';

/** RBJ-cookbook biquad, direct form I. */
export class Biquad {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(
    private readonly type: FilterType,
    frequency: number,
    q: number,
    private readonly sampleRate: number,
  ) {
    this.set(frequency, q);
  }

  set(frequency: number, q: number): void {
    const w = (2 * Math.PI * Math.min(frequency, this.sampleRate * 0.45)) / this.sampleRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    let b0: number;
    let b1: number;
    let b2: number;
    switch (this.type) {
      case 'lowpass':
        b0 = (1 - cos) / 2;
        b1 = 1 - cos;
        b2 = (1 - cos) / 2;
        break;
      case 'highpass':
        b0 = (1 + cos) / 2;
        b1 = -(1 + cos);
        b2 = (1 + cos) / 2;
        break;
      case 'bandpass':
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        break;
    }
    const a0 = 1 + alpha;
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Attack-then-exponential-decay envelope. */
export function envelope(t: number, attack: number, decay: number): number {
  if (t < attack) return t / attack;
  return Math.exp(-(t - attack) / decay);
}

/** Scales a signal to a target peak and applies gentle tanh saturation. */
export function finish(samples: Float32Array, peak: number, drive = 1.2): Float32Array {
  let max = 1e-9;
  for (let i = 0; i < samples.length; i++) max = Math.max(max, Math.abs(samples[i]));
  const k = 1 / max;
  const norm = Math.tanh(drive);
  for (let i = 0; i < samples.length; i++) samples[i] = (Math.tanh(samples[i] * k * drive) / norm) * peak;
  // Short fade-out so nothing clicks at the end of the buffer.
  const fade = Math.min(samples.length, 256);
  for (let i = 0; i < fade; i++) samples[samples.length - 1 - i] *= i / fade;
  return samples;
}

/** Sine with an exponential pitch drop (thumps, booms). */
export function addSweep(
  out: Float32Array,
  sampleRate: number,
  f0: number,
  dropRatio: number,
  dropTime: number,
  decay: number,
  gain: number,
  start = 0,
): void {
  let phase = 0;
  for (let i = Math.floor(start * sampleRate); i < out.length; i++) {
    const t = i / sampleRate - start;
    const f = f0 * (1 + dropRatio * Math.exp(-t / dropTime));
    phase += (2 * Math.PI * f) / sampleRate;
    out[i] += Math.sin(phase) * envelope(t, 0.0015, decay) * gain;
  }
}

/** Filtered noise burst. */
export function addNoise(
  out: Float32Array,
  sampleRate: number,
  rng: () => number,
  filter: Biquad | null,
  attack: number,
  decay: number,
  gain: number,
  start = 0,
): void {
  for (let i = Math.floor(start * sampleRate); i < out.length; i++) {
    const t = i / sampleRate - start;
    const n = rng() * 2 - 1;
    out[i] += (filter ? filter.process(n) : n) * envelope(t, attack, decay) * gain;
  }
}

/**
 * Voiced source through vowel formants: additive glottal pulse (harmonics with
 * a spectral tilt) filtered by three parallel band-passes, plus breath noise.
 */
export function voice(
  sampleRate: number,
  duration: number,
  rng: () => number,
  pitch: (t: number) => number,
  amplitude: (t: number) => number,
  formants: readonly (readonly [number, number, number])[],
  breathiness: number,
): Float32Array {
  const n = Math.floor(duration * sampleRate);
  const source = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const f0 = pitch(t) * (1 + (rng() - 0.5) * 0.01); // a little jitter
    phase += (2 * Math.PI * f0) / sampleRate;
    let s = 0;
    const harmonics = Math.min(40, Math.floor(3500 / f0));
    for (let h = 1; h <= harmonics; h++) s += Math.sin(phase * h) / Math.pow(h, 1.1);
    source[i] = s * 0.3 + (rng() * 2 - 1) * breathiness;
  }
  const out = new Float32Array(n);
  for (const [freq, q, gain] of formants) {
    const bp = new Biquad('bandpass', freq, q, sampleRate);
    for (let i = 0; i < n; i++) out[i] += bp.process(source[i]) * gain;
  }
  for (let i = 0; i < n; i++) out[i] *= amplitude(i / sampleRate);
  return out;
}
