import type { XRSupport } from '../core/XRSessionManager';

function requireElement<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`Missing #${id} element in index.html`);
  return el;
}

/**
 * The 2D landing overlay (desktop / pre-VR): title, Enter VR button, status
 * line and control hints. Hidden while an XR session is running.
 */
export class Overlay {
  private readonly root = requireElement('overlay', HTMLDivElement);
  private readonly button = requireElement('enter-vr', HTMLButtonElement);
  private readonly status = requireElement('xr-status', HTMLParagraphElement);
  private readonly speedInput = requireElement('punch-speed', HTMLInputElement);
  private readonly speedOutput = requireElement('punch-speed-value', HTMLOutputElement);
  private onEnter: (() => Promise<void>) | null = null;

  constructor() {
    this.button.addEventListener('click', () => void this.handleClick());
    this.speedInput.addEventListener('input', () => {
      this.speedOutput.value = `${this.punchSpeed.toFixed(1)} m/s`;
    });
  }

  /** Desktop punch strength from the slider (m/s). */
  get punchSpeed(): number {
    return Number(this.speedInput.value);
  }

  setSupport(support: XRSupport, onEnter: () => Promise<void>): void {
    this.onEnter = onEnter;
    if (support.supported) {
      this.button.disabled = false;
      this.button.textContent = 'Enter VR';
      this.setStatus('Headset detected.');
    } else {
      this.button.disabled = true;
      this.button.textContent = 'VR unavailable';
      this.setStatus(support.reason);
    }
  }

  setStatus(message: string, isError = false): void {
    this.status.textContent = message;
    this.status.classList.toggle('error', isError);
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  private async handleClick(): Promise<void> {
    if (!this.onEnter || this.button.disabled) return;
    this.button.disabled = true;
    this.setStatus('Starting VR session…');
    try {
      await this.onEnter();
      this.setStatus('');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus(`Could not start VR: ${message}`, true);
    } finally {
      this.button.disabled = false;
    }
  }
}
