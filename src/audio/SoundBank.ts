import { addNoise, addSweep, Biquad, createRng, envelope, finish, voice } from './dsp';

export type ImpactSurface = 'body' | 'face' | 'slap' | 'glove';

const VARIANTS = 3;
const TIERS = 4;

/** Yields to the event loop so synthesis doesn't freeze a frame for long. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * All game sounds, synthesised procedurally (Section 9): impact layers per
 * strength tier and surface with several variants each, grunts, a knockdown
 * groan, breaths and a gym ambience loop.
 */
export class SoundBank {
  /** [surface][tier][variant] */
  readonly impacts: Record<ImpactSurface, AudioBuffer[][]> = { body: [], face: [], slap: [], glove: [] };
  /** Tiny wet ticks for drops landing (very quiet). */
  readonly drips: AudioBuffer[] = [];
  readonly grunts: AudioBuffer[] = [];
  readonly groans: AudioBuffer[] = [];
  readonly breathIn: AudioBuffer[] = [];
  readonly breathOut: AudioBuffer[] = [];
  ambience: AudioBuffer | null = null;
  ready = false;

  private constructor(private readonly context: BaseAudioContext) {}

  /** Builds the bank a sound at a time, yielding between sounds. */
  static async build(context: BaseAudioContext): Promise<SoundBank> {
    const bank = new SoundBank(context);
    const sr = context.sampleRate;
    for (const surface of ['body', 'face', 'slap', 'glove'] as const) {
      for (let tier = 0; tier < TIERS; tier++) {
        const variants: AudioBuffer[] = [];
        for (let v = 0; v < VARIANTS; v++) {
          variants.push(bank.toBuffer(synthImpact(sr, surface, tier, 1000 + tier * 10 + v + surface.length * 100)));
          await nextTick();
        }
        bank.impacts[surface].push(variants);
      }
    }
    for (let v = 0; v < 4; v++) {
      bank.grunts.push(bank.toBuffer(synthGrunt(sr, 77 + v)));
      await nextTick();
    }
    for (let v = 0; v < 2; v++) {
      bank.groans.push(bank.toBuffer(synthGroan(sr, 300 + v)));
      bank.breathIn.push(bank.toBuffer(synthBreath(sr, 500 + v, true)));
      bank.breathOut.push(bank.toBuffer(synthBreath(sr, 600 + v, false)));
      await nextTick();
    }
    for (let v = 0; v < 4; v++) bank.drips.push(bank.toBuffer(synthDrip(sr, 900 + v)));
    bank.ambience = bank.toBuffer(synthAmbience(sr, 9));
    bank.ready = true;
    return bank;
  }

  private toBuffer(samples: Float32Array): AudioBuffer {
    const buffer = this.context.createBuffer(1, samples.length, this.context.sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    return buffer;
  }
}

/**
 * Punch impacts. Body: low fleshy thump. Face: sharper slap with a mid knock;
 * heavier tiers add a bony crack and a sub "boom". Slap: open hand.
 */
function synthImpact(sr: number, surface: ImpactSurface, tier: number, seed: number): Float32Array {
  const rng = createRng(seed);
  const vary = (x: number, amount = 0.15): number => x * (1 + (rng() - 0.5) * 2 * amount);
  const out = new Float32Array(Math.floor((0.28 + 0.12 * tier) * sr));

  if (surface === 'slap') {
    addNoise(out, sr, rng, new Biquad('bandpass', vary(3200), 0.8, sr), 0.0005, vary(0.022 + 0.006 * tier), 1);
    addNoise(out, sr, rng, new Biquad('highpass', 5000, 0.7, sr), 0.0003, 0.006, 0.5);
    addSweep(out, sr, vary(220), 0.4, 0.01, 0.025, 0.25 + 0.1 * tier);
    return finish(out, 0.3 + 0.12 * tier, 1.5);
  }

  if (surface === 'glove') {
    // Padded leather "thump": deep, rounded, with a short leather pop and no slap.
    addSweep(out, sr, vary(85 - 10 * tier), 1.1, 0.014, vary(0.06 + 0.035 * tier), 1);
    addNoise(out, sr, rng, new Biquad('lowpass', vary(450 + 150 * tier), 0.7, sr), 0.002, vary(0.035 + 0.01 * tier), 0.8);
    addNoise(out, sr, rng, new Biquad('bandpass', vary(900), 1.2, sr), 0.001, 0.012, 0.35);
    if (tier === 3) addSweep(out, sr, vary(48, 0.1), 0.7, 0.02, 0.14, 0.8);
    return finish(out, 0.42 + 0.17 * tier, 1.2 + 0.2 * tier);
  }

  if (surface === 'body') {
    addSweep(out, sr, vary(95 - 12 * tier), 1.4, 0.012, vary(0.05 + 0.03 * tier), 1);
    addNoise(out, sr, rng, new Biquad('lowpass', vary(650 + 300 * tier), 0.7, sr), 0.001, vary(0.025 + 0.008 * tier), 0.7);
  } else {
    addNoise(out, sr, rng, new Biquad('bandpass', vary(1900, 0.25), 0.9, sr), 0.0005, vary(0.016 + 0.004 * tier), 0.9);
    addNoise(out, sr, rng, new Biquad('highpass', 4200, 0.7, sr), 0.0003, 0.005, 0.35);
    addSweep(out, sr, vary(150 - 15 * tier), 1.0, 0.008, vary(0.04 + 0.02 * tier), 0.6 + 0.15 * tier);
  }
  if (tier >= 2) {
    // Bony crack: a very short broadband click plus a knock.
    addNoise(out, sr, rng, new Biquad('highpass', 1500, 0.6, sr), 0.0002, 0.0025, 1.2);
    addSweep(out, sr, vary(330), 0.3, 0.004, 0.02, 0.5);
  }
  if (tier === 3) addSweep(out, sr, vary(45, 0.1), 0.8, 0.02, 0.16, 0.9);
  return finish(out, 0.4 + 0.18 * tier, 1.3 + 0.2 * tier);
}

/** Short effortful "uh" (vowel formants F1 ≈ 620, F2 ≈ 1150, F3 ≈ 2600 Hz). */
function synthGrunt(sr: number, seed: number): Float32Array {
  const rng = createRng(seed);
  const duration = 0.26 + rng() * 0.12;
  const f0 = 125 + rng() * 25;
  const samples = voice(
    sr,
    duration,
    rng,
    (t) => f0 * (1 - 0.25 * (t / duration)),
    (t) => envelope(t, 0.012, duration * 0.35),
    [
      [600 + rng() * 60, 5, 1],
      [1100 + rng() * 120, 7, 0.55],
      [2550, 9, 0.22],
    ],
    0.08,
  );
  return finish(samples, 0.55, 1.4);
}

/** Long falling "ohh" for a knockdown, with a tremble. */
function synthGroan(sr: number, seed: number): Float32Array {
  const rng = createRng(seed);
  const duration = 1.15 + rng() * 0.2;
  const samples = voice(
    sr,
    duration,
    rng,
    (t) => (115 - 33 * (t / duration)) * (1 + 0.02 * Math.sin(2 * Math.PI * 5.5 * t)),
    (t) => Math.min(1, t / 0.08) * Math.exp(-Math.max(0, t - 0.25) / 0.45),
    [
      [480, 5, 1],
      [820, 6, 0.6],
      [2500, 9, 0.18],
    ],
    0.12,
  );
  return finish(samples, 0.5, 1.2);
}

/** Breath through the mouth: band-passed noise swell. */
function synthBreath(sr: number, seed: number, inhale: boolean): Float32Array {
  const rng = createRng(seed);
  const duration = inhale ? 0.45 : 0.55;
  const out = new Float32Array(Math.floor(duration * sr));
  const bp = new Biquad('bandpass', inhale ? 1400 : 900, 0.7, sr);
  const hp = new Biquad('highpass', 250, 0.7, sr);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr / duration;
    const swell = Math.sin(Math.PI * Math.min(1, t)) ** (inhale ? 1.5 : 1.2);
    out[i] = hp.process(bp.process(rng() * 2 - 1)) * swell;
  }
  return finish(out, inhale ? 0.22 : 0.3, 1);
}

/** A blood drop landing: tiny bandpassed tick with a wet pitch-up blip. */
function synthDrip(sr: number, seed: number): Float32Array {
  const rng = createRng(seed);
  const out = new Float32Array(Math.floor(0.09 * sr));
  addNoise(out, sr, rng, new Biquad('bandpass', 2500 + rng() * 1500, 2, sr), 0.0003, 0.004, 0.6);
  let phase = 0;
  const f0 = 900 + rng() * 500;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    phase += (2 * Math.PI * f0 * (1 + 2.5 * t / 0.05)) / sr;
    out[i] += Math.sin(phase) * envelope(t, 0.002, 0.012) * 0.4;
  }
  return finish(out, 0.25, 1);
}

/** Seamless room tone: low rumble, faint air, and distant heavy-bag thuds. */
function synthAmbience(sr: number, seed: number): Float32Array {
  const rng = createRng(seed);
  const duration = 8;
  const fade = 0.5;
  const n = Math.floor((duration + fade) * sr);
  const out = new Float32Array(n);
  const lp = new Biquad('lowpass', 280, 0.7, sr);
  const hp = new Biquad('highpass', 3000, 0.7, sr);
  let brown = 0;
  for (let i = 0; i < n; i++) {
    brown = brown * 0.995 + (rng() * 2 - 1) * 0.05;
    out[i] = lp.process(brown) * 0.9 + hp.process(rng() * 2 - 1) * 0.015;
  }
  for (let k = 0; k < 6; k++) {
    const thud = new Float32Array(n);
    addSweep(thud, sr, 70 + rng() * 25, 0.8, 0.01, 0.1, 0.35, 0.3 + rng() * (duration - 0.8));
    const lpThud = new Biquad('lowpass', 400, 0.7, sr);
    for (let i = 0; i < n; i++) out[i] += lpThud.process(thud[i]);
  }
  // Crossfade the tail into the head so the loop has no seam.
  const loop = new Float32Array(Math.floor(duration * sr));
  const f = Math.floor(fade * sr);
  for (let i = 0; i < loop.length; i++) loop[i] = out[i];
  for (let i = 0; i < f; i++) {
    const a = i / f;
    loop[i] = out[i] * a + out[loop.length + i] * (1 - a);
  }
  let max = 1e-9;
  for (let i = 0; i < loop.length; i++) max = Math.max(max, Math.abs(loop[i]));
  for (let i = 0; i < loop.length; i++) loop[i] *= 0.5 / max;
  return loop;
}
