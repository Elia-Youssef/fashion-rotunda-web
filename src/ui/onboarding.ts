// First-visit onboarding sequence: guides the visitor through orbit, looks and lights.
// Shows a card near each target element. Advances on user action or button click.
// Remembers completion in localStorage so subsequent visits show nothing.

import './onboarding.css';

import { prefersReducedMotion } from './announce';

export interface OnboardingStep {
  id: 'orbit' | 'looks' | 'lights';
  title: string;
  text: string;
  /** The element the step points at, by selector; the step waits for it to exist. */
  anchor: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: 'orbit',
    title: 'Explore the room',
    text: 'Drag or use arrow keys to rotate the view around the plinth.',
    anchor: '#scene',
  },
  {
    id: 'looks',
    title: 'Select a look',
    text: 'Choose from the collection of garments along the left edge.',
    anchor: '#looks',
  },
  {
    id: 'lights',
    title: 'Adjust lighting',
    text: 'Fine-tune studio lights and sun angle in the side panel.',
    anchor: '.lightpanel',
  },
];

export interface OnboardingOptions {
  root: HTMLElement;
  storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | null;
  /** Fires when a step is dismissed by the visitor doing the action. */
  onDismissed?: (id: OnboardingStep['id']) => void;
}

export interface OnboardingHandle {
  /** Advances past a step when its action happened (a drag, a look switch, a light change). */
  complete(id: OnboardingStep['id']): void;
  /** Starts the sequence unless the storage says it ran; shows nothing then. */
  start(): void;
  dispose(): void;
}

export const ONBOARDING_STORAGE_KEY = 'fashion-rotunda.onboarded';

const MARGIN_PX = 16;

export function mountOnboarding(options: OnboardingOptions): OnboardingHandle {
  let activeStepIndex = -1;
  let running = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let observer: MutationObserver | null = null;

  const card = document.createElement('div');
  card.className = 'onboarding-card';
  if (prefersReducedMotion()) {
    card.classList.add('onboarding-card--reduced-motion');
  }
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', 'Onboarding guide');
  // Programmatically focusable, never a tab stop of its own: focusing the card on each step puts
  // Skip and Next one Tab away, because the card sits last in the body and Tab only moves forward.
  card.tabIndex = -1;
  card.hidden = true;

  const titleEl = document.createElement('h2');
  titleEl.className = 'onboarding-card__title';

  const textEl = document.createElement('p');
  textEl.className = 'onboarding-card__text';

  const actions = document.createElement('div');
  actions.className = 'onboarding-card__actions';

  const skipBtn = document.createElement('button');
  skipBtn.type = 'button';
  skipBtn.className = 'onboarding-card__skip';
  skipBtn.textContent = 'Skip';

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'onboarding-card__next';
  nextBtn.textContent = 'Next';

  actions.append(skipBtn, nextBtn);
  card.append(titleEl, textEl, actions);

  /** Whatever held focus when the sequence started, so dismissing the card gives it back. */
  let focusBeforeStart: HTMLElement | null = null;

  function finish(): void {
    running = false;
    activeStepIndex = -1;
    stopWaiting();
    try {
      options.storage?.setItem(ONBOARDING_STORAGE_KEY, 'done');
    } catch {
      // Storage might be disabled or restricted in private browsing.
    }
    card.hidden = true;
    card.remove();
    // Removing a focused card drops focus on nothing, so hand it back deliberately.
    if (focusBeforeStart !== null && focusBeforeStart.isConnected) {
      focusBeforeStart.focus();
    } else {
      document.body.focus();
    }
    focusBeforeStart = null;
  }

  skipBtn.addEventListener('click', () => {
    finish();
  });

  nextBtn.addEventListener('click', () => {
    if (activeStepIndex < ONBOARDING_STEPS.length - 1) {
      showStep(activeStepIndex + 1);
    } else {
      finish();
    }
  });

  function stopWaiting(): void {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (observer !== null) {
      observer.disconnect();
      observer = null;
    }
  }

  function positionNearAnchor(anchor: HTMLElement, stepId: OnboardingStep['id']): void {
    const rect = anchor.getBoundingClientRect();
    const cardWidth = card.offsetWidth || 280;
    const cardHeight = card.offsetHeight || 120;

    let x = MARGIN_PX;
    let y = MARGIN_PX;

    if (stepId === 'orbit') {
      x = Math.max(MARGIN_PX, rect.left + 80);
      y = Math.max(MARGIN_PX, rect.bottom - cardHeight - 80);
    } else if (stepId === 'looks') {
      x = rect.right + 12;
      y = Math.max(MARGIN_PX, rect.top);
    } else if (stepId === 'lights') {
      x = Math.max(MARGIN_PX, rect.left - cardWidth - 12);
      y = Math.max(MARGIN_PX, rect.top);
    }

    const maxX = window.innerWidth - cardWidth - MARGIN_PX;
    const maxY = window.innerHeight - cardHeight - MARGIN_PX;
    x = Math.max(MARGIN_PX, Math.min(x, maxX));
    y = Math.max(MARGIN_PX, Math.min(y, maxY));

    card.style.setProperty('--onboarding-x', `${Math.round(x)}px`);
    card.style.setProperty('--onboarding-y', `${Math.round(y)}px`);
  }

  function present(anchor: HTMLElement, stepId: OnboardingStep['id']): void {
    if (!card.isConnected) {
      options.root.appendChild(card);
    }
    card.hidden = false;
    positionNearAnchor(anchor, stepId);
    card.focus();
  }

  function showStep(index: number): void {
    if (!running || index < 0 || index >= ONBOARDING_STEPS.length) {
      return;
    }
    stopWaiting();
    activeStepIndex = index;
    const step = ONBOARDING_STEPS[index];

    titleEl.textContent = step.title;
    textEl.textContent = step.text;
    nextBtn.textContent = index === ONBOARDING_STEPS.length - 1 ? 'Done' : 'Next';

    const anchor = document.querySelector<HTMLElement>(step.anchor);
    if (anchor !== null) {
      present(anchor, step.id);
      return;
    }

    // Anchor does not exist yet; wait for DOM mutations or poll briefly.
    card.hidden = true;
    observer = new MutationObserver(() => {
      const el = document.querySelector<HTMLElement>(step.anchor);
      if (el !== null) {
        stopWaiting();
        present(el, step.id);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    let attempts = 0;
    function poll(): void {
      attempts += 1;
      const el = document.querySelector<HTMLElement>(step.anchor);
      if (el !== null) {
        stopWaiting();
        present(el, step.id);
      } else if (attempts < 50 && running) {
        pollTimer = setTimeout(poll, 100);
      }
    }
    poll();
  }

  return {
    start(): void {
      // Only a stored key stops the sequence. Optional chaining here would yield undefined for a
      // null storage, which is not null either, and the sequence would never run without storage.
      const storage = options.storage;
      if (storage !== null) {
        try {
          if (storage.getItem(ONBOARDING_STORAGE_KEY) !== null) {
            return;
          }
        } catch {
          // Continue if storage is restricted.
        }
      }
      const active = document.activeElement;
      focusBeforeStart = active instanceof HTMLElement && active !== document.body ? active : null;
      running = true;
      showStep(0);
    },
    complete(id: OnboardingStep['id']): void {
      if (!running || activeStepIndex < 0 || activeStepIndex >= ONBOARDING_STEPS.length) {
        return;
      }
      const step = ONBOARDING_STEPS[activeStepIndex];
      if (step.id === id) {
        options.onDismissed?.(id);
        if (activeStepIndex < ONBOARDING_STEPS.length - 1) {
          showStep(activeStepIndex + 1);
        } else {
          finish();
        }
      }
    },
    dispose(): void {
      running = false;
      stopWaiting();
      card.remove();
    },
  };
}
