import { AudioListener, type Camera, type Object3D, PositionalAudio, type Scene, Vector3 } from 'three';
import type { OpponentState } from '../opponent/Opponent';
import { type ImpactSurface, SoundBank } from './SoundBank';

const POOL_SIZE = 8;
const BREATH_PERIOD = 3.6;

function pick<T>(list: readonly T[]): T | undefined {
  return list[Math.floor(Math.random() * list.length)];
}

/** ±5% pitch variation (Section 9). */
function randomRate(): number {
  return 0.95 + Math.random() * 0.1;
}

/**
 * Positional audio (Section 9). The listener rides on the camera (and so on
 * the headset in VR). Impacts play from a small pool of positional sources at
 * the hit point; the opponent's voice and breathing come from his head; the
 * gym ambience loops from two far corners.
 */
export class AudioSystem {
  readonly listener = new AudioListener();
  private readonly pool: PositionalAudio[] = [];
  private nextSource = 0;
  private readonly voice: PositionalAudio;
  private readonly breath: PositionalAudio;
  private readonly ambience: PositionalAudio[] = [];
  private bank: SoundBank | null = null;
  private unlocked = false;
  private breathPhase = 0;
  private breathInhale = true;
  /** Breathing is suppressed for a moment after a vocalisation. */
  private voiceBusyUntil = 0;
  private time = 0;

  constructor(camera: Camera, scene: Scene, opponentHead: Object3D) {
    camera.add(this.listener);
    this.listener.setMasterVolume(0.9);

    for (let i = 0; i < POOL_SIZE; i++) {
      const source = new PositionalAudio(this.listener);
      source.setRefDistance(1.2);
      source.setRolloffFactor(1.2);
      scene.add(source);
      this.pool.push(source);
    }

    this.voice = new PositionalAudio(this.listener);
    this.breath = new PositionalAudio(this.listener);
    for (const source of [this.voice, this.breath]) {
      source.setRefDistance(1);
      // Mouth position relative to the head bone (roughly; any rig).
      source.position.set(0, 0.06, 0.1);
      opponentHead.add(source);
    }

    for (const position of [new Vector3(-8, 2.5, -8), new Vector3(8, 2.5, 7)]) {
      const source = new PositionalAudio(this.listener);
      source.position.copy(position);
      source.setRefDistance(12);
      source.setLoop(true);
      source.setVolume(0.35);
      scene.add(source);
      this.ambience.push(source);
    }

    // The context starts suspended until a user gesture; synthesise meanwhile.
    void SoundBank.build(this.listener.context).then((bank) => {
      this.bank = bank;
      this.startAmbience();
    });
  }

  /** Call from a user gesture (click, key, Enter VR): browsers block audio until then. */
  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    void this.listener.context.resume().then(() => this.startAmbience());
  }

  get ready(): boolean {
    return this.bank !== null && this.listener.context.state === 'running';
  }

  /** Impact layered by tier (0 light .. 3 devastating) and surface. */
  playImpact(surface: ImpactSurface, tier: number, position: Vector3): void {
    const buffer = this.bank && pick(this.bank.impacts[surface][Math.max(0, Math.min(3, tier))]);
    if (!buffer || !this.ready) return;
    const source = this.pool[this.nextSource];
    this.nextSource = (this.nextSource + 1) % this.pool.length;
    if (source.isPlaying) source.stop();
    source.position.copy(position);
    source.updateMatrixWorld();
    source.setBuffer(buffer);
    source.setPlaybackRate(randomRate());
    source.setVolume(0.7 + 0.1 * tier);
    source.play();
  }

  /** A blood drop landing: a tiny, very quiet wet tick (Section 9). */
  playDrip(position: Vector3, intensity: number): void {
    const buffer = this.bank && pick(this.bank.drips);
    if (!buffer || !this.ready) return;
    const source = this.pool[this.nextSource];
    if (source.isPlaying) return; // never cut off an impact for a drip
    this.nextSource = (this.nextSource + 1) % this.pool.length;
    source.position.copy(position);
    source.updateMatrixWorld();
    source.setBuffer(buffer);
    source.setPlaybackRate(0.85 + Math.random() * 0.3);
    source.setVolume(0.06 + 0.1 * intensity);
    source.play();
  }

  /** Grunt on a hard hit. */
  playGrunt(intensity: number): void {
    this.playVoice(this.bank?.grunts, 0.5 + 0.5 * Math.min(1, intensity), 0.9);
  }

  /** Groan on knockdown. */
  playGroan(): void {
    this.playVoice(this.bank?.groans, 0.9, 2.2);
  }

  private playVoice(list: readonly AudioBuffer[] | undefined, volume: number, busyFor: number): void {
    const buffer = list && pick(list);
    if (!buffer || !this.ready) return;
    if (this.voice.isPlaying) this.voice.stop();
    if (this.breath.isPlaying) this.breath.stop();
    this.voice.setBuffer(buffer);
    this.voice.setPlaybackRate(randomRate());
    this.voice.setVolume(volume);
    this.voice.play();
    this.voiceBusyUntil = this.time + busyFor;
  }

  /**
   * Breathing gets faster and louder as damage accumulates; silent while out cold.
   * @param fatigue 0..1 from the damage model
   */
  update(dt: number, fatigue: number, state: OpponentState): void {
    this.time += dt;
    if (!this.ready || !this.bank) return;
    const period = BREATH_PERIOD - 1.6 * fatigue;
    this.breathPhase += dt / (period / 2);
    if (this.breathPhase < 1) return;
    this.breathPhase -= 1;
    this.breathInhale = !this.breathInhale;
    if (state === 'knockedOut' || this.time < this.voiceBusyUntil) return;
    const buffer = pick(this.breathInhale ? this.bank.breathIn : this.bank.breathOut);
    if (!buffer) return;
    if (this.breath.isPlaying) this.breath.stop();
    this.breath.setBuffer(buffer);
    this.breath.setPlaybackRate(randomRate() * (1 + 0.15 * fatigue));
    this.breath.setVolume(0.08 + 0.7 * fatigue);
    this.breath.play();
  }

  private startAmbience(): void {
    if (!this.bank?.ambience || this.listener.context.state !== 'running') return;
    this.ambience.forEach((source, i) => {
      if (source.isPlaying || !this.bank?.ambience) return;
      source.setBuffer(this.bank.ambience);
      // Offset the two copies so the loop doesn't phase.
      source.offset = i * 3.7;
      source.play();
    });
  }
}
