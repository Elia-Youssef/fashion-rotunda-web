// Accessibility and onboarding setup.
// Configures the canvas accessible name, installs tooltips, wires the polite live region
// MutationObserver for page state announcements, and drives the onboarding sequence.

import type { Announcer } from './announce';
import type { CameraMount, CameraMode } from '../camera/mount';
import { ONBOARDING_STORAGE_KEY, mountOnboarding } from './onboarding';
import type { OnboardingHandle } from './onboarding';
import { variantDisplayName } from './product-card';
import { installTooltips } from './tooltip';

export interface A11yMountOptions {
  root: HTMLElement;
  aside: HTMLElement;
  canvas: HTMLCanvasElement;
  search: string;
  announcer: Pick<Announcer, 'say'>;
  camera?: Pick<CameraMount, 'mode' | 'onModeChange'>;
}

export interface A11yMount {
  onboarding: OnboardingHandle;
  announcer: Pick<Announcer, 'say'>;
  dispose(): void;
}

const CANVAS_LABEL =
  'Showroom. Drag to orbit, arrow keys to turn, plus and minus to zoom, ' +
  'Page Up and Page Down to move up and down, Home to reset';

const WALK_CANVAS_LABEL =
  'Showroom, walk mode. Click to look around, W A S D or arrow keys to move, ' +
  'Shift to walk faster, Esc to release the mouse, O to return to orbit.';

const ORBIT_ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

export function mountA11y(options: A11yMountOptions): A11yMount {
  const { root, aside, canvas, search, announcer } = options;

  // The canvas: role="img" is wrong for an interactive surface; keep tabindex="0".
  canvas.removeAttribute('role');
  canvas.tabIndex = 0;

  let cameraMode = options.camera?.mode ?? 'orbit';
  function updateCameraMode(mode: CameraMode): void {
    cameraMode = mode;
    canvas.setAttribute('aria-label', mode === 'walk' ? WALK_CANVAS_LABEL : CANVAS_LABEL);
  }
  updateCameraMode(cameraMode);
  const unlistenMode = options.camera?.onModeChange(updateCameraMode);

  const tooltips = installTooltips(root);

  const params = new URLSearchParams(search);
  if (params.get('onboarding') === 'reset') {
    try {
      localStorage.removeItem(ONBOARDING_STORAGE_KEY);
    } catch {
      // Ignore storage restrictions.
    }
  }

  const onboarding = mountOnboarding({
    root,
    storage: localStorage,
  });

  const isE2E = params.get('e2e') === '1';
  const forceOnboarding = params.get('onboarding') === '1';
  if (!isE2E || forceOnboarding) {
    onboarding.start();
  }

  // Pointer drag on canvas completes the orbit step.
  let canvasPointerDown = false;
  function onPointerDown(): void {
    canvasPointerDown = true;
  }
  function onPointerUp(): void {
    if (canvasPointerDown) {
      canvasPointerDown = false;
      onboarding.complete('orbit');
    }
  }
  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);

  function onCanvasKeyDown(event: KeyboardEvent): void {
    if (cameraMode === 'orbit' && document.activeElement === canvas && ORBIT_ARROW_KEYS.has(event.key)) {
      onboarding.complete('orbit');
    }
  }
  canvas.addEventListener('keydown', onCanvasKeyDown);

  // Input inside the light panel completes the lights step. The listener sits on the root, not
  // on the card root: the panel lives in its own shell region and the input event bubbles.
  function onPanelInput(event: Event): void {
    const target = event.target;
    if (target instanceof Element && target.closest('.lightpanel') !== null) {
      onboarding.complete('lights');
    }
  }
  root.addEventListener('input', onPanelInput);

  function lookupLookName(lookId: string): string {
    const stripLabel = root.querySelector<HTMLElement>(
      `#looks button[data-look="${lookId}"] .catalog-strip__label`,
    );
    if (stripLabel?.textContent) {
      return stripLabel.textContent;
    }
    const cardHeading = aside.querySelector<HTMLElement>('.product-card__name');
    if (cardHeading?.textContent) {
      return cardHeading.textContent;
    }
    return lookId;
  }

  // Initial state tracking to avoid announcing defaults at boot.
  let prevLook = canvas.dataset['look'] ?? null;
  let prevVariant = canvas.dataset['variant'] ?? null;

  const rotateButton = aside.querySelector<HTMLButtonElement>('button[data-action="rotate"]');
  let prevRotate = rotateButton?.getAttribute('aria-pressed') ?? null;

  const musicButton = root.querySelector<HTMLButtonElement>('header button.music-switch');
  let prevMusicPressed = musicButton?.getAttribute('aria-pressed') ?? null;

  const canvasObserver = new MutationObserver(() => {
    const currentLook = canvas.dataset['look'] ?? null;
    if (currentLook !== null && currentLook !== prevLook) {
      prevLook = currentLook;
      onboarding.complete('looks');
      const name = lookupLookName(currentLook);
      announcer.say(`Now showing: ${name}`);
    }

    const currentVariant = canvas.dataset['variant'] ?? null;
    if (currentVariant !== null && currentVariant !== prevVariant) {
      prevVariant = currentVariant;
      announcer.say(`Mannequin: ${variantDisplayName(currentVariant)}`);
    }
  });
  canvasObserver.observe(canvas, { attributes: true, attributeFilter: ['data-look', 'data-variant'] });

  const asideObserver = new MutationObserver(() => {
    const btn = aside.querySelector<HTMLButtonElement>('button[data-action="rotate"]');
    if (btn !== null) {
      const pressed = btn.getAttribute('aria-pressed');
      if (pressed !== null && pressed !== prevRotate) {
        prevRotate = pressed;
        announcer.say(pressed === 'true' ? 'Rotate on' : 'Rotate off');
      }
    }
  });
  asideObserver.observe(aside, { attributes: true, subtree: true, attributeFilter: ['aria-pressed'] });

  const headerEl = musicButton?.closest('header') ?? null;
  const headerObserver = new MutationObserver(() => {
    const btn = musicButton;
    if (btn !== null) {
      const pressed = btn.getAttribute('aria-pressed');
      // Playback progress can change while the switch stays on. Announce only on/off changes.
      if (pressed !== null && pressed !== prevMusicPressed) {
        prevMusicPressed = pressed;
        announcer.say(pressed === 'true' ? 'Music on' : 'Music off');
      }
    }
  });
  if (headerEl !== null) {
    headerObserver.observe(headerEl, {
      attributes: true,
      subtree: true,
      attributeFilter: ['aria-pressed'],
    });
  }

  let disposed = false;
  return {
    onboarding,
    announcer,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unlistenMode?.();
      canvas.removeEventListener('keydown', onCanvasKeyDown);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      root.removeEventListener('input', onPanelInput);
      canvasObserver.disconnect();
      asideObserver.disconnect();
      headerObserver.disconnect();
      tooltips.dispose();
      onboarding.dispose();
    },
  };
}
