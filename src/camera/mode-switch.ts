// Goal G4.3: camera mode switch UI.
// Two buttons (Orbit and Walk), aria-pressed on the active one, keyboard reachable,
// and data-tooltip set ("Orbit inspection camera", "Walk the showroom floor" or "Loading the floor").

import './mode-switch.css';
import type { CameraMode, CameraMount } from './mount';

export type ModeSwitchMount = Pick<CameraMount, 'mode' | 'setMode' | 'onModeChange'> & {
  readonly walkReady?: boolean;
  onWalkReady?: (listener: () => void) => () => void;
};

/**
 * Two buttons, Orbit and Walk, aria-pressed on the active one, keyboard reachable, data-tooltip set.
 */
export function mountModeSwitch(
  root: HTMLElement,
  mount: ModeSwitchMount,
): { dispose(): void } {
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

  orbitButton.addEventListener('click', onOrbitClick);
  walkButton.addEventListener('click', onWalkClick);

  container.appendChild(orbitButton);
  container.appendChild(walkButton);
  root.appendChild(container);

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
      unlistenMode();
      if (unlistenWalkReady !== null) {
        unlistenWalkReady();
      }
      container.remove();
    },
  };
}
