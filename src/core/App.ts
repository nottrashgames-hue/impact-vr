import {
  ACESFilmicToneMapping,
  Color,
  Fog,
  PCFShadowMap,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { AudioSystem } from '../audio/AudioSystem';
import { BloodSystem } from '../blood/BloodSystem';
import { FloorBlood } from '../blood/FloorBlood';
import { VisorSplatter } from '../blood/VisorSplatter';
import { KNOCKOUT, PHYSICS, WORLD } from '../config';
import { DamageModel } from '../damage/DamageModel';
import { HitPipeline } from '../damage/HitPipeline';
import { InjurySystem } from '../damage/InjurySystem';
import { debugStats } from '../debug/DebugStats';
import { HitProbe } from '../debug/HitProbe';
import { PerfHUD } from '../debug/PerfHUD';
import { RenderTargetView } from '../debug/RenderTargetView';
import { Gym } from '../environment/Gym';
import { DesktopControls } from '../input/DesktopControls';
import { type Handedness, type XRButtonName, XRInput } from '../input/XRInput';
import type { HumanoidRig } from '../opponent/HumanoidRig';
import { loadOpponentRig, Opponent } from '../opponent/Opponent';
import { OpponentBrain } from '../opponent/OpponentBrain';
import { FistColliders } from '../player/FistColliders';
import { GloveContact } from '../player/GloveContact';
import { GloveRack } from '../player/GloveRack';
import { Locomotion } from '../player/Locomotion';
import { PlayerHands } from '../player/PlayerHands';
import { DESKTOP_FOV, PlayerRig } from '../player/PlayerRig';
import { PunchDetector } from '../player/PunchDetector';
import { SkinSurface } from '../skin/SkinSurface';
import { HitFlash } from '../ui/HitFlash';
import { Overlay } from '../ui/Overlay';
import { StatsPanel } from '../ui/StatsPanel';
import { UIPointer } from '../ui/UIPointer';
import { WorldPrompt } from '../ui/WorldPrompt';
import { WristMenu } from '../ui/WristMenu';
import { GameLoop } from './GameLoop';
import { Physics } from './Physics';
import { QUALITY_PRESETS, type QualityPreset } from './Quality';
import { bloodScale, type Settings, SettingsStore } from './Settings';
import { type XRSessionInfo, XRSessionManager } from './XRSessionManager';

/** Desktop monitors: used only to colour the HUD's fps readout. */
const DESKTOP_DISPLAY_RATE = 60;

const _headPos = new Vector3();
const _opponentPos = new Vector3();
const _headQuat = new Quaternion();
const _rayOrigin = new Vector3();
const _rayDir = new Vector3();

/**
 * Application root: owns the renderer, scene, player rig and every subsystem,
 * and wires them into the fixed-step loop. Construct with {@link App.create}.
 */
export class App {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly rig: PlayerRig;
  readonly gym: Gym;
  readonly input: XRInput;
  readonly hands: PlayerHands;
  readonly opponent: Opponent;
  readonly damage = new DamageModel();
  readonly audio: AudioSystem;
  readonly hits: HitPipeline;
  readonly hud: PerfHUD;
  readonly rack: GloveRack;
  readonly skin: SkinSurface;
  readonly injuries: InjurySystem;
  readonly blood: BloodSystem;
  readonly brain: OpponentBrain;
  readonly menu: WristMenu;
  private quality: QualityPreset;
  private readonly visor: VisorSplatter;
  private readonly fistColliders: FistColliders;
  private readonly punches: PunchDetector;
  private readonly contact: GloveContact;
  private readonly locomotion: Locomotion;
  private readonly knockoutPrompt = new WorldPrompt();
  private readonly pointer: UIPointer;
  private readonly stats: StatsPanel;
  private readonly targetsView: RenderTargetView;
  private readonly flash: HitFlash;
  private nextDesktopHand: Handedness = 'left';
  private readonly probe: HitProbe;
  private readonly raycaster = new Raycaster();
  private readonly desktop: DesktopControls;
  private readonly xr: XRSessionManager;
  private readonly loop: GameLoop;
  private session: XRSession | null = null;
  /** Recenter on the next XR frame that has a viewer pose. */
  private pendingRecenter = false;
  /** Seconds of game time (sum of frame deltas; pauses don't jump animation). */
  private elapsed = 0;

  /** Loads async dependencies (Rapier WASM, opponent model) and builds the app. */
  static async create(container: HTMLElement): Promise<App> {
    const overlay = new Overlay();
    const settings = new SettingsStore();
    const quality = QUALITY_PRESETS[settings.current.quality];
    const [physics, rig] = await Promise.all([Physics.create(), loadOpponentRig(quality)]);
    return new App(container, overlay, settings, quality, physics, rig);
  }

  private constructor(
    container: HTMLElement,
    private readonly overlay: Overlay,
    readonly settings: SettingsStore,
    quality: QualityPreset,
    readonly physics: Physics,
    rig: HumanoidRig,
  ) {
    this.quality = quality;

    // Renderer ---------------------------------------------------------------
    const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatioCap));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.xr.enabled = true;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    // Scene & player -----------------------------------------------------------
    this.scene.background = new Color(0x101216);
    this.scene.fog = new Fog(0x101216, 14, 32);
    this.camera = new PerspectiveCamera(DESKTOP_FOV, window.innerWidth / window.innerHeight, 0.03, 60);
    this.rig = new PlayerRig(this.camera);
    this.scene.add(this.rig.root);

    this.gym = new Gym(this.scene, renderer, quality);
    this.gym.addColliders(physics);

    this.opponent = new Opponent(this.scene, physics, rig);
    this.probe = new HitProbe(this.scene);
    debugStats.opponent =
      `${rig.kind} · ${(rig.triangles / 1000).toFixed(1)}k tris · ` +
      `${this.opponent.hitboxes.colliderCount} hitboxes · face ${rig.faceRegions.method}`;

    this.input = new XRInput(renderer, this.rig.root);
    this.hands = new PlayerHands(this.scene, this.camera, this.input);
    this.desktop = new DesktopControls(renderer.domElement, this.rig);
    this.desktop.reset();
    this.desktop.onClick(() => this.desktopPunch());

    // Punching (Milestone 3) ------------------------------------------------------
    this.audio = new AudioSystem(this.camera, this.scene, rig.bones.Head);
    this.fistColliders = new FistColliders(physics, this.hands);
    this.punches = new PunchDetector(physics, this.opponent, this.hands);
    this.hits = new HitPipeline(this.damage, this.opponent, this.audio, this.input);
    // Gloves resting on him push him around; thumbsticks walk and turn in VR.
    this.contact = new GloveContact(physics, this.hands, this.opponent, this.input);
    this.locomotion = new Locomotion(this.rig, this.camera, this.input);

    // Gloves (Milestone 4): rack beside the player, grab to equip; the menu equips both hands.
    this.rack = new GloveRack(this.scene);
    this.hands.onPinch((side) => this.grabAtRack(side));

    // Damage map (Milestone 5): bruises, swelling, black eyes, cuts.
    this.skin = new SkinSurface(rig, quality.skinPaintSize, this.opponent.metersPerBindUnit);
    this.injuries = new InjurySystem(this.skin, this.opponent, this.damage, this.settings);
    this.hits.onHit((impact, result) => this.injuries.onImpact(impact, result));

    // Blood (Milestones 6–8): bleeding, flow, drips, droplets, floor accumulation, transfer.
    const floorBlood = new FloorBlood(quality.floorBloodMapSize, this.gym.floor.material, (x, z, out) =>
      this.gym.worldToFloorUV(x, z, out),
    );
    this.visor = new VisorSplatter(this.camera);
    this.blood = new BloodSystem(
      this.scene,
      physics,
      this.opponent,
      this.hands,
      this.skin,
      floorBlood,
      this.audio,
      this.settings,
      this.damage,
      this.camera,
      this.visor,
    );
    this.injuries.onCut = (cut) => this.blood.addCut(cut);
    this.hits.onHit((impact, result) => this.blood.onImpact(impact, result));

    // UI & settings (Milestone 9) -------------------------------------------------
    this.knockoutPrompt.place(
      new Vector3(WORLD.opponentX, 2.15, WORLD.opponentZ),
      new Vector3(WORLD.playerSpawnX, 1.65, WORLD.playerSpawnZ),
    );
    this.scene.add(this.knockoutPrompt.mesh);
    this.hud = new PerfHUD(quality, settings.current.showHud);
    this.scene.add(this.hud.panel);
    this.menu = new WristMenu(settings, {
      resetOpponent: () => this.resetOpponent(),
      cleanFloor: () => this.blood.cleanFloor(this.renderer),
      resetAll: () => this.resetAll(),
      recenter: () => this.recenter(),
      matchHeight: () => this.matchHeight(),
    });
    this.scene.add(this.menu.panel.mesh);
    this.pointer = new UIPointer(this.scene, this.input);
    this.stats = new StatsPanel(this.hits.stats, this.damage);
    this.scene.add(this.stats.panel.mesh);
    this.targetsView = new RenderTargetView([
      { texture: this.skin.damageTexture, label: 'Damage map (bruise/fresh/swell/cut)' },
      { texture: this.skin.bloodTexture, label: 'Skin blood map' },
      { texture: floorBlood.target.texture, label: 'Floor blood map' },
    ]);
    this.scene.add(this.targetsView.group);
    this.flash = new HitFlash(this.camera);
    this.brain = new OpponentBrain(this.opponent, this.hands, this.flash, this.input, this.audio);

    // Browsers only start audio after a user gesture.
    const unlockAudio = (): void => this.audio.unlock();
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });

    // XR session ---------------------------------------------------------------
    this.xr = new XRSessionManager(renderer, quality);
    this.xr.onSessionStart((info) => this.onXRStart(info));
    this.xr.onSessionEnd(() => this.onXREnd());
    this.input.onButtonDown((side, button) => this.onXRButton(side, button));

    // Runs once now with every key, then on each change (menu, keys, buttons).
    this.settings.subscribe((s, changed) => this.applySettings(s, changed));

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('resize', this.onResize);

    // Loop ---------------------------------------------------------------------
    this.loop = new GameLoop(
      renderer,
      {
        fixedUpdate: (dt) => this.fixedUpdate(dt),
        update: (dt, alpha, frame) => this.update(dt, alpha, frame),
        render: () => {
          renderer.render(this.scene, this.camera);
          // Offscreen paint passes also count in renderer.info; keep the main pass's numbers.
          debugStats.drawCalls = renderer.info.render.calls;
          debugStats.triangles = renderer.info.render.triangles;
        },
      },
      PHYSICS.fixedStep,
      PHYSICS.maxSubSteps,
    );

    void this.xr.checkSupport().then((support) =>
      overlay.setSupport(support, () => {
        this.audio.unlock();
        return this.xr.enter();
      }),
    );
    this.loop.start();
  }

  /** Applies settings changes to every system (Section 10). */
  private applySettings(s: Readonly<Settings>, changed: ReadonlySet<keyof Settings>): void {
    if (changed.has('glovesOn') || changed.has('gloveColor') || changed.has('gloveWeight')) {
      for (const hand of this.hands.both) hand.setGlove(s.glovesOn ? s.gloveColor : null, s.gloveWeight);
      this.rack.sync(this.hands);
    }
    if (changed.has('blood') || changed.has('bloodColor') || changed.has('bruising')) {
      this.skin.applySettings(s, bloodScale(s));
    }
    if (changed.has('quality')) this.applyQuality(QUALITY_PRESETS[s.quality]);
    if (changed.has('showHud')) this.hud.setVisible(s.showHud);
    if (changed.has('showHitboxes')) {
      this.opponent.setDebugView(s.showHitboxes);
      if (!s.showHitboxes) this.probe.hide();
    }
    if (changed.has('showRenderTargets')) this.targetsView.setVisible(s.showRenderTargets);
    if (changed.has('showStats')) this.stats.setVisible(s.showStats, this.renderer.xr.isPresenting);
    if (changed.has('opponentMode')) this.brain.setMode(s.opponentMode);
    if (changed.has('koRecovery')) this.opponent.koRecovery = s.koRecovery;
    if (changed.has('heightOffset')) this.rig.setHeightOffset(s.heightOffset);
  }

  /** Height calibration: puts the player's eyes level with the opponent's (saved in settings). */
  private matchHeight(): void {
    const opponentEyes = this.opponent.rig.headCenter.y;
    const playerEyes = this.renderer.xr.isPresenting ? this.rig.trackedEyeHeight() : WORLD.desktopEyeHeight;
    const offset = Math.max(-1, Math.min(1, opponentEyes - playerEyes));
    this.settings.set({ heightOffset: Math.round(offset * 100) / 100 });
    this.input.pulse('left', 0.3, 40);
    this.input.pulse('right', 0.3, 40);
  }

  /** Quality presets (Section 11): particle cap, paint resolutions, shadows, foveation. */
  private applyQuality(preset: QualityPreset): void {
    const previous = this.quality;
    this.quality = preset;
    this.blood.setParticleCapacity(preset.maxParticles);
    debugStats.maxParticles = preset.maxParticles;
    if (preset.skinPaintSize !== previous.skinPaintSize) {
      this.skin.resize(preset.skinPaintSize);
      this.skin.clear(this.renderer);
    }
    if (preset.floorBloodMapSize !== previous.floorBloodMapSize) {
      this.blood.floor.resize(preset.floorBloodMapSize);
      this.blood.floor.clear(this.renderer);
    }
    const shadow = this.gym.lights.key.shadow;
    if (shadow.mapSize.x !== preset.shadowMapSize) {
      shadow.mapSize.set(preset.shadowMapSize, preset.shadowMapSize);
      shadow.map?.dispose();
      shadow.map = null;
    }
    this.hud.setQuality(preset);
    this.xr.setQuality(preset);
    if (!this.renderer.xr.isPresenting) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.pixelRatioCap));
    }
  }

  private fixedUpdate(dt: number): void {
    this.opponent.fixedUpdate(dt);
    this.physics.step(dt);
    this.opponent.afterPhysicsStep();
  }

  private update(dt: number, alpha: number, frame: XRFrame | undefined): void {
    this.elapsed += dt;
    const inXR = this.renderer.xr.isPresenting;
    const settings = this.settings.current;
    if (inXR) {
      this.input.update();
      if (this.pendingRecenter && frame) this.tryRecenter(frame);
      if (this.locomotion.update(dt, settings.smoothTurn)) {
        // A snap turn swings the fists around with the rig: don't sweep that as a punch.
        this.hands.resetTracking();
        this.punches.reset();
      }
    } else {
      this.desktop.update(dt);
    }

    // Player hands -> fist bodies -> sweep for hits against the opponent.
    this.hands.update(this.loop.frameTime, inXR, settings.dryingSpeed);
    this.fistColliders.update(this.elapsed);
    this.camera.getWorldQuaternion(_headQuat);
    this.punches.update(this.loop.frameTime, _headQuat, (impact) => {
      this.hits.handle(impact);
      if (this.opponent.state === 'knockedOut' && this.opponent.timeInState === 0) {
        this.fistColliders.suspend(this.elapsed, 0.5);
      }
    });
    this.contact.update(dt);
    this.damage.update(dt);

    // The opponent watches the player's head (last rendered camera pose in VR).
    this.camera.getWorldPosition(_headPos);
    this.brain.update(dt, _headPos);
    this.opponent.setEyeClosure(this.injuries.eyeClosure('eyeLeft'), this.injuries.eyeClosure('eyeRight'));
    this.opponent.update(dt, this.elapsed, _headPos, alpha, this.damage.fatigue);
    // He no longer stays on his spawn spot: keep the key light (and its shadow) on him.
    this.opponent.rig.bones.Hips.getWorldPosition(_opponentPos);
    this.gym.lights.key.target.position.set(_opponentPos.x, 0.9, _opponentPos.z);
    // Blood moves with the freshly posed body; then offscreen paint (queued stamps, aging) before the main render.
    this.blood.update(dt, this.renderer);
    this.visor.update(dt);
    this.skin.update(this.renderer, dt, settings);
    this.audio.update(dt, this.damage.fatigue, this.opponent.state);
    this.flash.update(dt);
    this.updateKnockoutPrompt();

    // UI.
    if (inXR) {
      const left = this.hands.left;
      this.menu.updateXR(dt, left.tracked ? left.gripMatrix : null, _headPos);
      this.pointer.update([this.menu.panel, this.stats.panel]);
    } else {
      this.menu.updateDesktop(dt);
    }
    this.stats.update(dt);
    if (this.opponent.debugVisible) this.probe.update(dt, this.opponent, this.probeRay(inXR));
    this.hits.updateDebug();
    this.physics.endFrame();

    this.hud.update(dt, {
      inXR,
      displayRate: inXR ? (this.session?.frameRate ?? this.quality.targetFrameRate) : DESKTOP_DISPLAY_RATE,
      hands: this.hands,
    });
  }

  /** Debug probe ray: mouse pointer on desktop, right controller in VR. */
  private probeRay(inXR: boolean): { origin: Vector3; direction: Vector3 } | null {
    if (inXR) {
      const slot = this.input.slotFor('right');
      if (!slot || this.input.modeOf('right') !== 'controller' || !slot.targetRay.visible) return null;
      slot.targetRay.updateWorldMatrix(true, false);
      _rayOrigin.setFromMatrixPosition(slot.targetRay.matrixWorld);
      _rayDir.set(0, 0, -1).transformDirection(slot.targetRay.matrixWorld);
      return { origin: _rayOrigin, direction: _rayDir };
    }
    if (!this.desktop.pointerInside) return null;
    this.raycaster.setFromCamera(this.desktop.pointer, this.camera);
    return { origin: this.raycaster.ray.origin, direction: this.raycaster.ray.direction };
  }

  /** Desktop (Section 12): punch at the cursor with the slider's speed, alternating hands. */
  private desktopPunch(): void {
    this.raycaster.setFromCamera(this.desktop.pointer, this.camera);
    const { origin, direction } = this.raycaster.ray;
    const hit = this.opponent.raycast(origin, direction, 3);
    // Aim at the surface, or throw at thin air 0.9 m out if the cursor misses him.
    const target = hit ? hit.point : origin.clone().addScaledVector(direction, 0.9);
    this.hands.startDesktopPunch(this.nextDesktopHand, target, this.overlay.punchSpeed);
    this.nextDesktopHand = this.nextDesktopHand === 'left' ? 'right' : 'left';
  }

  /** Grip button / pinch near the rack: take a glove onto that hand, or hang the worn one back up. */
  private grabAtRack(side: Handedness): void {
    const hand = this.hands.get(side);
    if (!hand.tracked) return;
    const result = this.rack.grab(side, hand.strikePoint, hand.gloveColor);
    if (!result) return;
    hand.setGlove(result === 'remove' ? null : result, this.settings.current.gloveWeight);
    this.rack.sync(this.hands);
    this.input.pulse(side, 0.4, 30);
  }

  /** Clears damage, blood on him and stats, and stands the opponent back up (Section 3). */
  private resetOpponent(): void {
    this.damage.reset();
    this.hits.resetStats();
    this.skin.clear(this.renderer);
    this.blood.resetOpponent();
    this.visor.clear();
    this.opponent.reset();
    this.brain.reset();
    this.punches.reset();
    this.knockoutPrompt.hide();
  }

  /** Reset Opponent + Clean Floor + clean gloves. */
  private resetAll(): void {
    this.resetOpponent();
    this.blood.cleanFloor(this.renderer);
    for (const hand of this.hands.both) hand.coating.clear();
  }

  private recenter(): void {
    if (this.renderer.xr.isPresenting) {
      this.pendingRecenter = true;
    } else {
      this.desktop.reset();
      this.hands.resetTracking();
      this.punches.reset();
    }
  }

  private updateKnockoutPrompt(): void {
    const opponent = this.opponent;
    if (opponent.state !== 'knockedOut' || opponent.timeInState < KNOCKOUT.promptDelay) {
      this.knockoutPrompt.hide();
      return;
    }
    if (!this.knockoutPrompt.mesh.visible) {
      // Over wherever he went down, facing the player.
      opponent.rig.bones.Hips.getWorldPosition(_opponentPos).setY(1.7);
      this.knockoutPrompt.place(_opponentPos, this.camera.getWorldPosition(_headPos));
    }
    if (opponent.koRecovery === 'getUp') {
      const left = Math.max(0, Math.ceil(KNOCKOUT.getUpDelay - opponent.timeInState));
      this.knockoutPrompt.show('KNOCKOUT!', `Getting up in ${left}…  (O / A to reset now)`);
    } else {
      this.knockoutPrompt.show('KNOCKOUT!', 'Press O (desktop) or A (VR) to reset');
    }
  }

  /** Places the tracked head on the spawn point facing the opponent. */
  private tryRecenter(frame: XRFrame): void {
    const referenceSpace = this.renderer.xr.getReferenceSpace();
    const pose = referenceSpace ? frame.getViewerPose(referenceSpace) : undefined;
    if (!pose) return;
    this.rig.recenterXR(pose.transform.position, pose.transform.orientation);
    this.hands.resetTracking();
    // The fists teleported with the rig: don't sweep across the gap.
    this.punches.reset();
    this.pendingRecenter = false;
  }

  private onXRStart(info: XRSessionInfo): void {
    this.session = info.session;
    this.overlay.setVisible(false);
    this.desktop.enabled = false;
    this.rig.setFloorOffset(info.referenceSpaceType === 'local' ? WORLD.desktopEyeHeight : 0);
    this.hud.setXR(true);
    this.stats.setVisible(this.settings.current.showStats, true);
    this.hands.resetTracking();
    this.loop.resetClock();
    this.pendingRecenter = true;
    // The system recenter gesture (hold the Meta button) resets the reference
    // space; recenter the rig against the new origin as well.
    this.renderer.xr.getReferenceSpace()?.addEventListener('reset', this.onReferenceSpaceReset);
    console.info(
      `[IMPACT] VR session started: ${info.referenceSpaceType}, hand tracking ${info.handTracking ? 'on' : 'off'}, ` +
        `quality ${this.quality.label}`,
    );
  }

  private onXREnd(): void {
    this.session = null;
    this.overlay.setVisible(true);
    this.desktop.enabled = true;
    this.desktop.reset();
    this.hud.setXR(false);
    this.stats.setVisible(this.settings.current.showStats, false);
    this.menu.pinned = false;
    this.hands.resetTracking();
    this.loop.resetClock();
    this.onResize();
  }

  /**
   * VR buttons: grip = grab at the rack; right trigger = click the menu; X = menu;
   * Y = HUD; A = reset after a knockout; B = match the opponent's height;
   * thumbstick click = recenter. The sticks themselves walk and turn (Locomotion).
   */
  private onXRButton(side: Handedness, button: XRButtonName): void {
    if (button === 'squeeze') {
      this.grabAtRack(side);
    } else if (button === 'trigger' && side === 'right') {
      if (this.pointer.click()) this.input.pulse('right', 0.25, 15);
    } else if (button === 'thumbstick') {
      this.recenter();
      this.input.pulse(side, 0.3, 40);
    } else if (button === 'secondary' && side === 'left') {
      this.settings.set({ showHud: !this.settings.current.showHud });
    } else if (button === 'primary' && side === 'left') {
      this.menu.pinned = !this.menu.pinned;
    } else if (button === 'primary' && side === 'right' && this.opponent.state === 'knockedOut') {
      this.resetOpponent();
    } else if (button === 'secondary' && side === 'right') {
      this.matchHeight();
    }
  }

  private readonly onReferenceSpaceReset = (): void => {
    this.pendingRecenter = true;
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || this.renderer.xr.isPresenting) return;
    const s = this.settings.current;
    switch (event.code) {
      case 'KeyR':
        this.recenter();
        break;
      case 'KeyH':
        this.settings.set({ showHud: !s.showHud });
        break;
      case 'KeyB':
        this.settings.set({ showHitboxes: !s.showHitboxes });
        break;
      case 'KeyO':
        this.resetOpponent();
        break;
      case 'KeyG':
        this.settings.set({ glovesOn: !s.glovesOn });
        break;
      case 'KeyF':
        this.blood.cleanFloor(this.renderer);
        break;
      case 'KeyM':
        this.menu.toggleDesktop();
        break;
    }
  };

  private readonly onResize = (): void => {
    if (this.renderer.xr.isPresenting) return; // the XR runtime owns the framebuffer size
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };
}
