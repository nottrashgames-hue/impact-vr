import {
  type Material,
  Mesh,
  type Object3D,
  type Vector2,
  type WebGLRenderer,
  type XRGripSpace,
  type XRHandSpace,
  type XRTargetRaySpace,
} from 'three';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';

export type Handedness = 'left' | 'right';
export type XRInputMode = 'controller' | 'hand';

/** Button indices of the `xr-standard` gamepad mapping (Quest Touch, Index, etc.). */
export const XR_BUTTONS = {
  trigger: 0,
  squeeze: 1,
  thumbstick: 3,
  /** A on the right controller, X on the left. */
  primary: 4,
  /** B on the right controller, Y on the left. */
  secondary: 5,
} as const;
export type XRButtonName = keyof typeof XR_BUTTONS;

const BUTTON_NAMES = Object.keys(XR_BUTTONS) as XRButtonName[];

/**
 * One of the two input-source slots three.js exposes. A slot is not tied to a
 * hand: when the user switches between controllers and hand tracking the
 * runtime may reassign sources, so always look sources up by handedness.
 */
export interface XRInputSlot {
  readonly index: number;
  readonly targetRay: XRTargetRaySpace;
  readonly grip: XRGripSpace;
  readonly hand: XRHandSpace;
  /** The articulated hand mesh (a child of `hand`; the joint groups are its siblings). */
  readonly handModel: Object3D;
  source: XRInputSource | null;
  /** Previous-frame pressed state per button, for edge detection. */
  readonly wasPressed: boolean[];
}

type ButtonListener = (side: Handedness, button: XRButtonName) => void;

/**
 * WebXR controllers + hand tracking. Both are always set up; which one is
 * active per hand is decided by the runtime (Quest switches automatically when
 * controllers are put down), and consumers query {@link modeOf} every frame.
 */
export class XRInput {
  readonly slots: readonly XRInputSlot[];
  private readonly buttonListeners: ButtonListener[] = [];
  private handMaterial: Material | null = null;
  private readonly handMeshes: Mesh[] = [];

  /** @param parent the player rig; spaces are positioned relative to it. */
  constructor(renderer: WebGLRenderer, parent: Object3D) {
    // Articulated hand meshes (generic-hand profile from the WebXR input-profiles CDN).
    const handFactory = new XRHandModelFactory(null, (model) => this.onHandModelLoaded(model));

    const slots: XRInputSlot[] = [];
    for (let i = 0; i < 2; i++) {
      const hand = renderer.xr.getHand(i);
      const slot: XRInputSlot = {
        index: i,
        targetRay: renderer.xr.getController(i),
        grip: renderer.xr.getControllerGrip(i),
        hand,
        handModel: handFactory.createHandModel(hand, 'mesh'),
        source: null,
        wasPressed: BUTTON_NAMES.map(() => false),
      };
      slot.hand.add(slot.handModel);
      parent.add(slot.targetRay, slot.grip, slot.hand);

      slot.targetRay.addEventListener('connected', (event) => {
        slot.source = event.data;
        slot.wasPressed.fill(false);
      });
      slot.targetRay.addEventListener('disconnected', () => {
        slot.source = null;
      });
      slots.push(slot);
    }
    this.slots = slots;
  }

  /** Shows or hides the articulated hand mesh of one hand (hidden while a glove is worn). */
  setHandModelVisible(side: Handedness, visible: boolean): void {
    const slot = this.slotFor(side);
    if (slot) slot.handModel.visible = visible;
  }

  /** Material applied to the tracked-hand meshes (so they match the fist models). */
  setHandMaterial(material: Material): void {
    this.handMaterial = material;
    for (const mesh of this.handMeshes) mesh.material = material;
  }

  onButtonDown(listener: ButtonListener): void {
    this.buttonListeners.push(listener);
  }

  /** The slot currently driven by the given hand, if any. */
  slotFor(side: Handedness): XRInputSlot | null {
    for (const slot of this.slots) {
      if (slot.source?.handedness === side) return slot;
    }
    return null;
  }

  /** Whether a hand is currently a controller, a tracked hand, or absent. */
  modeOf(side: Handedness): XRInputMode | null {
    const source = this.slotFor(side)?.source;
    if (!source) return null;
    return source.hand ? 'hand' : 'controller';
  }

  /** Polls gamepad buttons and fires press (rising-edge) events. Call once per XR frame. */
  update(): void {
    for (const slot of this.slots) {
      const source = slot.source;
      const gamepad = source?.gamepad;
      if (!source || !gamepad || (source.handedness !== 'left' && source.handedness !== 'right')) continue;
      const side = source.handedness;
      for (let b = 0; b < BUTTON_NAMES.length; b++) {
        const name = BUTTON_NAMES[b];
        const pressed = gamepad.buttons[XR_BUTTONS[name]]?.pressed ?? false;
        if (pressed && !slot.wasPressed[b]) {
          for (const listener of this.buttonListeners) listener(side, name);
        }
        slot.wasPressed[b] = pressed;
      }
    }
  }

  /**
   * Thumbstick deflection (-1..1 per axis; y is negative when pushed forward),
   * zero for tracked hands or a missing controller (`xr-standard` axes 2/3).
   */
  thumbstick(side: Handedness, out: Vector2): Vector2 {
    const axes = this.slotFor(side)?.source?.gamepad?.axes;
    return out.set(axes?.[2] ?? 0, axes?.[3] ?? 0);
  }

  /** Short haptic pulse on a controller. `intensity` 0..1, `durationMs` in milliseconds. */
  pulse(side: Handedness, intensity: number, durationMs: number): void {
    const actuator = this.slotFor(side)?.source?.gamepad?.hapticActuators?.[0];
    actuator?.pulse(Math.min(1, Math.max(0, intensity)), durationMs).catch(() => undefined);
  }

  private onHandModelLoaded(model: Object3D): void {
    model.traverse((child) => {
      if (child instanceof Mesh) {
        this.handMeshes.push(child);
        if (this.handMaterial) child.material = this.handMaterial;
      }
    });
  }
}
