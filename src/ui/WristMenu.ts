import { type Matrix4, Vector3 } from 'three';
import type { BloodColor, BloodLevel, OpponentMode, Settings, SettingsStore } from '../core/Settings';
import type { QualityLevel } from '../core/Quality';
import { GLOVE_COLOR_NAMES, GLOVE_COLORS, GLOVE_WEIGHTS } from '../player/GearProfile';
import { CanvasPanel, type Widget } from './CanvasPanel';

export interface MenuActions {
  resetOpponent(): void;
  cleanFloor(): void;
  resetAll(): void;
  recenter(): void;
  /** VR: raise/lower the player so their eyes are level with the opponent's. */
  matchHeight(): void;
}

type Page = 'main' | 'gore' | 'debug';

const W = 760;
const H = 700;
const PAD = 24;
const ROW = 50;

const _pos = new Vector3();
const _head = new Vector3();
const _x = new Vector3();

/**
 * The in-VR settings menu (Section 10), opened on the left hand: turn the
 * palm up or press X. Three tabs: gloves/opponent/resets, gore and quality,
 * and debug. On desktop the same panel is shown as an overlay (M key).
 */
export class WristMenu {
  readonly panel = new CanvasPanel(W, H, 0.34, 'IMPACT · Menu');
  private page: Page = 'main';
  /** Pinned open with the X button. */
  pinned = false;
  private palmUp = false;
  private desktopOpen = false;

  constructor(
    private readonly settings: SettingsStore,
    private readonly actions: MenuActions,
  ) {
    this.build();
    settings.subscribe((_s, changed) => {
      // The height label's text is baked into its widget.
      if (changed.has('heightOffset')) this.build();
      else this.panel.invalidate();
    });

    // Desktop: the same canvas as a clickable overlay.
    this.panel.canvas.className = 'wrist-menu hidden';
    document.body.appendChild(this.panel.canvas);
    this.panel.canvas.addEventListener('pointerdown', (e) => {
      const rect = this.panel.canvas.getBoundingClientRect();
      this.panel.click(((e.clientX - rect.left) / rect.width) * W, ((e.clientY - rect.top) / rect.height) * H);
      e.stopPropagation();
    });
    this.panel.canvas.addEventListener('pointermove', (e) => {
      const rect = this.panel.canvas.getBoundingClientRect();
      this.panel.hover(((e.clientX - rect.left) / rect.width) * W, ((e.clientY - rect.top) / rect.height) * H);
    });
    this.panel.canvas.addEventListener('pointerleave', () => this.panel.hover(null));
  }

  get visibleInXR(): boolean {
    return this.pinned || this.palmUp;
  }

  toggleDesktop(): void {
    this.desktopOpen = !this.desktopOpen;
    this.panel.canvas.classList.toggle('hidden', !this.desktopOpen);
    this.panel.invalidate();
  }

  /**
   * VR placement: floats just above the left hand, turned to face the head.
   * @param leftGrip world matrix of the left grip (null when the hand isn't tracked)
   */
  updateXR(dt: number, leftGrip: Matrix4 | null, headPosition: Vector3): void {
    if (leftGrip) {
      // Palm up: for the left hand the palm faces grip +X.
      _x.set(1, 0, 0).transformDirection(leftGrip);
      this.palmUp = _x.y > 0.75;
      _pos.setFromMatrixPosition(leftGrip);
    } else {
      this.palmUp = false;
    }
    const mesh = this.panel.mesh;
    mesh.visible = this.visibleInXR && leftGrip !== null;
    if (mesh.visible) {
      mesh.position.copy(_pos);
      mesh.position.y += 0.2;
      // Face the head (a plane's front is +Z, which lookAt points at the target), staying upright.
      mesh.lookAt(_head.copy(headPosition));
      mesh.updateMatrixWorld();
    }
    this.panel.update(dt);
  }

  updateDesktop(dt: number): void {
    this.panel.mesh.visible = false;
    if (this.desktopOpen) this.panel.update(dt);
  }

  private set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.settings.set({ [key]: value } as Partial<Settings>);
  }

  private build(): void {
    const s = (): Readonly<Settings> => this.settings.current;
    const widgets: Widget[] = [];
    const tabs: [Page, string][] = [
      ['main', 'Gloves & Opponent'],
      ['gore', 'Gore & Quality'],
      ['debug', 'Player & Debug'],
    ];
    const tabW = (W - PAD * 2 - 16) / 3;
    tabs.forEach(([page, text], i) => {
      widgets.push({
        kind: 'tab',
        x: PAD + i * (tabW + 8),
        y: 64,
        w: tabW,
        h: 44,
        text,
        state: () => this.page === page,
        action: () => {
          this.page = page;
          this.build();
        },
      });
    });

    let y = 128;
    const header = (text: string): void => {
      widgets.push({ kind: 'header', x: PAD, y, w: W - PAD * 2, h: 28, text });
      y += 32;
    };
    /** A row of equal-width option buttons. */
    const options = <T>(choices: readonly [T, string, string?][], get: () => T, apply: (v: T) => void): void => {
      const gap = 8;
      const w = (W - PAD * 2 - gap * (choices.length - 1)) / choices.length;
      choices.forEach(([value, text, swatch], i) => {
        widgets.push({
          kind: 'option',
          x: PAD + i * (w + gap),
          y,
          w,
          h: 42,
          text,
          swatch,
          state: () => get() === value,
          action: () => apply(value),
        });
      });
      y += ROW;
    };
    const buttons = (list: [string, () => void, (() => boolean)?][]): void => {
      const gap = 8;
      const w = (W - PAD * 2 - gap * (list.length - 1)) / list.length;
      list.forEach(([text, action, state], i) => {
        widgets.push({ kind: state ? 'toggle' : 'button', x: PAD + i * (w + gap), y, w, h: 42, text, action, state });
      });
      y += ROW;
    };
    const slider = (text: string, get: () => number, apply: (v: number) => void): void => {
      // Logarithmic 0.25x .. 4x.
      widgets.push({
        kind: 'slider',
        x: PAD,
        y,
        w: W - PAD * 2,
        h: 46,
        text,
        state: () => (Math.log2(get()) + 2) / 4,
        valueText: () => `${get().toFixed(2)}x`,
        action: (f) => apply(Math.round(Math.pow(2, f * 4 - 2) * 100) / 100),
      });
      y += 56;
    };

    if (this.page === 'main') {
      header('Gloves');
      buttons([['Gloves', () => this.set('glovesOn', !s().glovesOn), () => s().glovesOn]]);
      options(
        GLOVE_COLOR_NAMES.map((c) => [c, c[0].toUpperCase() + c.slice(1), `#${GLOVE_COLORS[c].toString(16).padStart(6, '0')}`] as [typeof c, string, string]),
        () => s().gloveColor,
        (c) => this.settings.set({ gloveColor: c, glovesOn: true }),
      );
      options(
        GLOVE_WEIGHTS.map((w) => [w, `${w} oz`] as [typeof w, string]),
        () => s().gloveWeight,
        (w) => this.set('gloveWeight', w),
      );
      header('Opponent');
      options<OpponentMode>(
        [
          ['passive', 'Passive dummy'],
          ['defensive', 'Defensive'],
          ['sparring', 'Sparring'],
        ],
        () => s().opponentMode,
        (m) => this.set('opponentMode', m),
      );
      options<Settings['koRecovery']>(
        [
          ['prompt', 'KO: wait for reset'],
          ['getUp', 'KO: gets back up'],
        ],
        () => s().koRecovery,
        (v) => this.set('koRecovery', v),
      );
      header('Reset');
      buttons([
        ['Reset Opponent', () => this.actions.resetOpponent()],
        ['Clean Floor', () => this.actions.cleanFloor()],
        ['Reset All', () => this.actions.resetAll()],
      ]);
    } else if (this.page === 'gore') {
      header('Blood');
      options<BloodLevel>(
        [
          ['off', 'Off'],
          ['low', 'Low'],
          ['medium', 'Medium'],
          ['high', 'High'],
        ],
        () => s().blood,
        (v) => this.set('blood', v),
      );
      options<BloodColor>(
        [
          ['red', 'Red', '#8a1010'],
          ['green', 'Green', '#2f6d1c'],
          ['off', 'Colour off'],
        ],
        () => s().bloodColor,
        (v) => this.set('bloodColor', v),
      );
      buttons([
        ['Bruising & swelling', () => this.set('bruising', !s().bruising), () => s().bruising],
        ['Visor splatter', () => this.set('visorSplatter', !s().visorSplatter), () => s().visorSplatter],
        ['Healing', () => this.set('healing', !s().healing), () => s().healing],
      ]);
      slider('Drying speed', () => s().dryingSpeed, (v) => this.set('dryingSpeed', v));
      slider('Bruise development speed', () => s().bruiseSpeed, (v) => this.set('bruiseSpeed', v));
      header('Quality (particles, blood map resolution)');
      options<QualityLevel>(
        [
          ['quest2', 'Quest 2'],
          ['quest3', 'Quest 3'],
          ['pc', 'PC'],
        ],
        () => s().quality,
        (q) => this.set('quality', q),
      );
    } else {
      header('Player (VR)');
      buttons([
        ['Match opponent height', () => this.actions.matchHeight()],
        ['Reset height', () => this.set('heightOffset', 0)],
      ]);
      buttons([
        ['Smooth turning', () => this.set('smoothTurn', !s().smoothTurn), () => s().smoothTurn],
        ['Recenter', () => this.actions.recenter()],
      ]);
      widgets.push({
        kind: 'label',
        x: PAD,
        y,
        w: W - PAD * 2,
        h: 30,
        text: `Height offset ${s().heightOffset >= 0 ? '+' : ''}${(s().heightOffset * 100).toFixed(0)} cm · left stick walk · right stick turn`,
      });
      y += 40;
      header('Debug');
      buttons([
        ['Performance HUD', () => this.set('showHud', !s().showHud), () => s().showHud],
        ['Hitboxes & zones', () => this.set('showHitboxes', !s().showHitboxes), () => s().showHitboxes],
      ]);
      buttons([
        ['Render targets', () => this.set('showRenderTargets', !s().showRenderTargets), () => s().showRenderTargets],
        ['Stats panel', () => this.set('showStats', !s().showStats), () => s().showStats],
      ]);
      widgets.push({
        kind: 'label',
        x: PAD,
        y: y + 8,
        w: W - PAD * 2,
        h: 30,
        text: 'Desktop: G gloves · F clean floor · O reset · M menu',
      });
    }
    this.panel.setWidgets(widgets);
  }
}
