// Camera mode switch UI.
// Two buttons (Orbit and Walk), aria-pressed on the active one, keyboard reachable,
// and tooltips describing the camera actions.

import './mode-switch.css';
import type { Announcer } from '../ui/announce';
import type { CameraMode, CameraMount } from './mount';

export type ModeSwitchMount = Pick<CameraMount,
  'mode' | 'setMode' | 'onModeChange' | 'pendingMode' | 'walkLoadState' | 'onWalkStateChange'>;

export interface ModeSwitchOptions {
  hasPointerLock?: boolean;
  canvas: HTMLCanvasElement;
  announcer: Pick<Announcer, 'say'>;
}

const WALK_LABELS = { idle: 'Walk', loading: 'Loading Walk...', error: 'Retry Walk' };

/** Two camera-mode buttons plus the Walk pointer-lock escape guidance. */
export function mountModeSwitch(
  root: HTMLElement,
  mount: ModeSwitchMount,
  options: ModeSwitchOptions,
): { dispose(): void } {
  const hasPointerLock = options.hasPointerLock ?? true;
  const container = document.createElement('nav');
  container.className = 'archviz-mode-switch';
  container.setAttribute('aria-label', 'Camera view mode');

  const orbitButton = document.createElement('button');
  orbitButton.type = 'button';
  orbitButton.className = 'archviz-mode-button';
  orbitButton.setAttribute('data-mode', 'orbit');
  orbitButton.setAttribute('data-tooltip', 'Orbit inspection camera');
  orbitButton.textContent = 'Orbit';

  const walkButton = document.createElement('button');
  walkButton.type = 'button';
  walkButton.className = 'archviz-mode-button';
  walkButton.setAttribute('data-mode', 'walk');
  walkButton.setAttribute('data-tooltip', 'Walk the showroom floor');
  walkButton.setAttribute('data-reserve-labels', Object.values(WALK_LABELS).join('\n'));
  const walkLabel = document.createElement('span');
  walkLabel.className = 'archviz-mode-label';
  walkButton.appendChild(walkLabel);

  const walkHint = document.createElement('p');
  walkHint.className = 'archviz-walk-hint';
  walkHint.id = 'archviz-walk-hint';
  walkHint.hidden = true;
  walkHint.textContent =
    'Walk: click the scene to look. Press Esc to release the mouse, then select Orbit. Press O to return to Orbit.';

  const escapeText = walkHint.textContent;
  const announcer = options.announcer;
  let lastNotice = '';
  let disposed = false;

  function updateLoad(): void {
    const pending = mount.pendingMode === 'walk';
    const failed = mount.walkLoadState === 'error';
    const notice = pending ? WALK_LABELS.loading : failed ? 'Walk could not load. Try again.' : '';
    const label = pending ? WALK_LABELS.loading : failed ? WALK_LABELS.error : WALK_LABELS.idle;
    walkLabel.textContent = label;
    walkButton.setAttribute('aria-label', label);
    walkButton.setAttribute('aria-disabled', String(pending));
    container.setAttribute('aria-busy', String(pending));
    walkHint.textContent = failed ? notice : escapeText;
    walkHint.hidden = !failed && (mount.mode !== 'walk' || !hasPointerLock);
    const speech = notice || (mount.mode === 'walk' && hasPointerLock ? escapeText : '');
    if (speech !== lastNotice) {
      if (speech) announcer.say(speech);
      lastNotice = speech;
    }
  }

  function updateActive(mode: CameraMode): void {
    orbitButton.setAttribute('aria-pressed', mode === 'orbit' ? 'true' : 'false');
    walkButton.setAttribute('aria-pressed', mode === 'walk' ? 'true' : 'false');
    updateLoad();
  }

  updateActive(mount.mode);

  function onOrbitClick(): void {
    void mount.setMode('orbit').catch(() => {});
  }

  function onWalkClick(): void {
    if (mount.pendingMode !== 'walk' && mount.mode !== 'walk') {
      void mount.setMode('walk').catch(() => {});
    }
  }

  let orbitShortcutPending = false;
  function onKeyDown(event: KeyboardEvent): void {
    const canvas = options.canvas;
    // Pointer lock owns scene input even when clicking a canvas did not move DOM focus.
    const sceneOwnsKeyboard = document.activeElement === canvas || document.pointerLockElement === canvas;
    const source = event.target;
    const interactiveSource =
      source instanceof HTMLElement &&
      source.closest('a, button, input, select, textarea, [contenteditable]') !== null;
    if (
      event.code !== 'KeyO' ||
      event.repeat ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      interactiveSource ||
      !sceneOwnsKeyboard ||
      !hasPointerLock ||
      mount.mode !== 'walk' ||
      orbitShortcutPending
    ) {
      return;
    }

    event.preventDefault();
    orbitShortcutPending = true;
    void mount.setMode('orbit').catch(() => {}).finally(() => {
      if (disposed) return;
      orbitShortcutPending = false;
    });
  }

  orbitButton.addEventListener('click', onOrbitClick);
  walkButton.addEventListener('click', onWalkClick);
  window.addEventListener('keydown', onKeyDown);

  container.appendChild(orbitButton);
  container.appendChild(walkButton);
  root.appendChild(container);
  // The product card sits in a higher shell layer than the header. Mount guidance above both
  // so the exit instruction remains readable when the card is open.
  document.body.appendChild(walkHint);

  const unlistenMode = mount.onModeChange((mode) => {
    updateActive(mode);
  });

  const unlistenLoad = mount.onWalkStateChange(updateLoad);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      orbitButton.removeEventListener('click', onOrbitClick);
      walkButton.removeEventListener('click', onWalkClick);
      window.removeEventListener('keydown', onKeyDown);
      unlistenMode();
      unlistenLoad();
      container.remove();
      walkHint.remove();
    },
  };
}
