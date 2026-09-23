// Goal G4.3: camera mode switch UI.
// Two buttons (Orbit and Walk), aria-pressed on the active one, keyboard reachable,
// and data-tooltip set ("Orbit inspection camera", "Walk the showroom floor" or "Loading the floor").

import './mode-switch.css';
import type { CameraMode, CameraMount } from './mount';

export type ModeSwitchMount = Pick<CameraMount, 'mode' | 'setMode' | 'onModeChange'> & {
  readonly walkReady?: boolean;
  onWalkReady?: (listener: () => void) => () => void;
};

export interface ModeSwitchOptions {
  hasPointerLock?: boolean;
}

/** Two camera-mode buttons plus the Walk pointer-lock escape guidance. */
export function mountModeSwitch(
  root: HTMLElement,
  mount: ModeSwitchMount,
  options: ModeSwitchOptions = {},
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
  walkButton.textContent = 'Walk';

  const walkHint = document.createElement('p');
  walkHint.className = 'archviz-walk-hint';
  walkHint.id = 'archviz-walk-hint';
  walkHint.hidden = true;
  walkHint.setAttribute('aria-live', 'polite');
  walkHint.textContent =
    'Walk: click the scene to look. Press Esc to release the mouse, then select Orbit. Press O to return to Orbit.';

  const isReady = mount.walkReady ?? true;
  if (!isReady) {
    walkButton.disabled = true;
    walkButton.setAttribute('data-tooltip', 'Loading the floor');
  } else {
    walkButton.disabled = false;
    walkButton.setAttribute('data-tooltip', 'Walk the showroom floor');
  }

  function updateActive(mode: CameraMode): void {
    orbitButton.setAttribute('aria-pressed', mode === 'orbit' ? 'true' : 'false');
    walkButton.setAttribute('aria-pressed', mode === 'walk' ? 'true' : 'false');
    walkHint.hidden = mode !== 'walk' || !hasPointerLock;
  }

  updateActive(mount.mode);

  function onOrbitClick(): void {
    if (mount.mode !== 'orbit') {
      void mount.setMode('orbit');
    }
  }

  function onWalkClick(): void {
    if (!walkButton.disabled && mount.mode !== 'walk') {
      void mount.setMode('walk');
    }
  }

  let orbitShortcutPending = false;
  function onKeyDown(event: KeyboardEvent): void {
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
      !hasPointerLock ||
      mount.mode !== 'walk' ||
      orbitShortcutPending
    ) {
      return;
    }

    event.preventDefault();
    orbitShortcutPending = true;
    void mount.setMode('orbit').finally(() => {
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

  let unlistenWalkReady: (() => void) | null = null;
  if (typeof mount.onWalkReady === 'function') {
    unlistenWalkReady = mount.onWalkReady(() => {
      walkButton.disabled = false;
      walkButton.setAttribute('data-tooltip', 'Walk the showroom floor');
    });
  }

  return {
    dispose(): void {
      orbitButton.removeEventListener('click', onOrbitClick);
      walkButton.removeEventListener('click', onWalkClick);
      window.removeEventListener('keydown', onKeyDown);
      unlistenMode();
      if (unlistenWalkReady !== null) {
        unlistenWalkReady();
      }
      container.remove();
      walkHint.remove();
    },
  };
}
