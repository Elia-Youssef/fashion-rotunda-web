// Accessibility and onboarding orchestrator.
// Configures the canvas accessible name, installs tooltips, wires the polite live region
// MutationObserver for page state announcements, and drives the onboarding sequence.

import { mountAnnouncer } from './announce';
import type { Announcer } from './announce';
import { ONBOARDING_STORAGE_KEY, mountOnboarding } from './onboarding';
import type { OnboardingHandle } from './onboarding';
import { installTooltips } from './tooltip';

export interface A11yMountOptions {
  root: HTMLElement;
  aside: HTMLElement;
  canvas: HTMLCanvasElement;
  search: string;
}

export interface A11yMount {
  onboarding: OnboardingHandle;
  announcer: Announcer;
  dispose(): void;
}

const CANVAS_LABEL =
  'Showroom. Drag to orbit, arrow keys to turn, plus and minus to zoom, Home to reset';

export function mountA11y(options: A11yMountOptions): A11yMount {
  const { root, aside, canvas, search } = options;

  // The canvas: role="img" is wrong for an interactive surface; keep tabindex="0".
  canvas.removeAttribute('role');
  canvas.setAttribute('aria-label', CANVAS_LABEL);
  canvas.tabIndex = 0;

  const tooltips = installTooltips(root);
  const announcer = mountAnnouncer(root);

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
  let prevLook = canvas.dataset.look ?? null;
  let prevVariant = canvas.dataset.variant ?? null;

  const rotateButton = aside.querySelector<HTMLButtonElement>('button[data-action="rotate"]');
  let prevRotate = rotateButton?.getAttribute('aria-pressed') ?? null;

  const musicButton = root.querySelector<HTMLButtonElement>('header button.music-switch');
  let prevMusicPressed = musicButton?.getAttribute('aria-pressed') ?? null;
  let prevMusicState = musicButton?.dataset.music ?? null;

  const canvasObserver = new MutationObserver(() => {
    const currentLook = canvas.dataset.look ?? null;
    if (currentLook !== null && currentLook !== prevLook) {
      prevLook = currentLook;
      onboarding.complete('looks');
      const name = lookupLookName(currentLook);
      announcer.say(`Now showing: ${name}`);
    }

    const currentVariant = canvas.dataset.variant ?? null;
    if (currentVariant !== null && currentVariant !== prevVariant) {
      prevVariant = currentVariant;
      announcer.say(`Mannequin: ${currentVariant}`);
    }
  });
  canvasObserver.observe(canvas, { attributes: true, attributeFilter: ['data-look', 'data-variant'] });

  const asideObserver = new MutationObserver(() => {
    const btn = aside.querySelector<HTMLButtonElement>('button[data-action="rotate"]');
    if (btn !== null) {
      const pressed = btn.getAttribute('aria-pressed');
      if (pressed !== null && pressed !== prevRotate) {
        prevRotate = pressed;
        announcer.say(pressed === 'true' ? 'Turntable on' : 'Turntable off');
      }
    }
  });
  asideObserver.observe(aside, { attributes: true, subtree: true, attributeFilter: ['aria-pressed'] });

  const headerEl = root.querySelector('header');
  const headerObserver = new MutationObserver(() => {
    const btn = root.querySelector<HTMLButtonElement>('header button.music-switch');
    if (btn !== null) {
      const pressed = btn.getAttribute('aria-pressed');
      const state = btn.dataset.music ?? null;
      if (pressed !== null && (pressed !== prevMusicPressed || state !== prevMusicState)) {
        prevMusicPressed = pressed;
        prevMusicState = state;
        announcer.say(pressed === 'true' ? 'Music on' : 'Music off');
      }
    }
  });
  if (headerEl !== null) {
    headerObserver.observe(headerEl, {
      attributes: true,
      subtree: true,
      attributeFilter: ['aria-pressed', 'data-music'],
    });
  }

  return {
    onboarding,
    announcer,
    dispose(): void {
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      root.removeEventListener('input', onPanelInput);
      canvasObserver.disconnect();
      asideObserver.disconnect();
      headerObserver.disconnect();
      tooltips.dispose();
      announcer.dispose();
      onboarding.dispose();
    },
  };
}
