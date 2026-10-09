// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ONBOARDING_STEPS,
  ONBOARDING_STORAGE_KEY,
  mountOnboarding,
} from '../../src/ui/onboarding';
import type { OnboardingHandle } from '../../src/ui/onboarding';

let root: HTMLElement;
let handle: OnboardingHandle | null = null;
let fakeStorage: Map<string, string>;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);

  // Create anchor elements so step presentation can find them.
  const scene = document.createElement('canvas');
  scene.id = 'scene';
  const looks = document.createElement('nav');
  looks.id = 'looks';
  const lightpanel = document.createElement('section');
  lightpanel.className = 'lightpanel';
  const lightToggle = document.createElement('button');
  lightToggle.id = 'shell-light-toggle';
  lightToggle.textContent = 'Light Control';

  document.body.append(scene, looks, lightToggle, lightpanel);

  fakeStorage = new Map<string, string>();
});

afterEach(() => {
  handle?.dispose();
  handle = null;
  root.remove();
  document.querySelector('#scene')?.remove();
  document.querySelector('#looks')?.remove();
  document.querySelector('#shell-light-toggle')?.remove();
  document.querySelector('.lightpanel')?.remove();
});

function storageAdapter() {
  return {
    getItem(key: string): string | null {
      return fakeStorage.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      fakeStorage.set(key, value);
    },
  };
}

describe('ONBOARDING_STEPS', () => {
  it('defines the three required steps in order', () => {
    expect(ONBOARDING_STEPS).toHaveLength(3);
    expect(ONBOARDING_STEPS.map((s) => s.id)).toEqual(['orbit', 'looks', 'lights']);
    expect(ONBOARDING_STEPS.map((s) => s.anchor)).toEqual(['#scene', '#looks', '#shell-light-toggle']);
  });
});

describe('mountOnboarding', () => {
  it.each(['skip', 'next'] as const)('retires a retained %s control on disposal', (control) => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    const onDismissed = vi.fn();
    handle = mountOnboarding({ root, storage, onDismissed });
    handle.start();
    if (control === 'next') {
      handle.complete('orbit');
      handle.complete('looks');
    }
    const card = root.querySelector<HTMLElement>('.onboarding-card')!;
    const retained = card.querySelector<HTMLButtonElement>(`.onboarding-card__${control}`)!;
    const title = card.querySelector('.onboarding-card__title')!;
    const stepTitle = title.textContent;
    handle.dispose();
    onDismissed.mockClear();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    retained.click();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(onDismissed).not.toHaveBeenCalled();
    expect(title.textContent).toBe(stepTitle);
    expect(card.isConnected).toBe(false);
    focus.mockRestore();
  });

  it('keeps public methods inert after final disposal', () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    const onDismissed = vi.fn();
    handle = mountOnboarding({ root, storage, onDismissed });
    handle.start();
    const card = root.querySelector<HTMLElement>('.onboarding-card')!;
    const title = card.querySelector('.onboarding-card__title')!;
    handle.dispose();
    storage.getItem.mockClear();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    handle.start();
    handle.complete('orbit');
    handle.complete('looks');
    handle.complete('lights');
    expect(card.isConnected).toBe(false);
    expect(title.textContent).toBe(ONBOARDING_STEPS[0].title);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(onDismissed).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    focus.mockRestore();
  });

  it('starts on step 0 and presents title, text, Next and Skip buttons', () => {
    handle = mountOnboarding({
      root,
      storage: storageAdapter(),
    });
    handle.start();

    const card = root.querySelector('.onboarding-card');
    expect(card).not.toBeNull();
    expect((card as HTMLElement).hidden).toBe(false);

    const title = root.querySelector('.onboarding-card__title');
    expect(title?.textContent).toBe(ONBOARDING_STEPS[0].title);
    const text = root.querySelector('.onboarding-card__text');
    expect(text?.textContent).toBe(ONBOARDING_STEPS[0].text);

    const skipBtn = root.querySelector('.onboarding-card__skip');
    expect(skipBtn?.textContent).toBe('Skip');
    const nextBtn = root.querySelector('.onboarding-card__next');
    expect(nextBtn?.textContent).toBe('Next');
  });

  it('clicking Next steps through sequence and writes storage key upon completion', () => {
    handle = mountOnboarding({
      root,
      storage: storageAdapter(),
    });
    handle.start();

    const nextBtn = root.querySelector<HTMLButtonElement>('.onboarding-card__next');
    const title = root.querySelector<HTMLElement>('.onboarding-card__title');

    // Step 0 -> Step 1
    nextBtn?.click();
    expect(title?.textContent).toBe(ONBOARDING_STEPS[1].title);
    expect(nextBtn?.textContent).toBe('Next');

    // Step 1 -> Step 2
    nextBtn?.click();
    expect(title?.textContent).toBe(ONBOARDING_STEPS[2].title);
    expect(nextBtn?.textContent).toBe('Done');

    // Step 2 -> Finish
    nextBtn?.click();
    expect(root.querySelector('.onboarding-card')).toBeNull();
    expect(fakeStorage.get(ONBOARDING_STORAGE_KEY)).toBe('done');
  });

  it('clicking Skip dismisses the card and sets the storage key immediately', () => {
    handle = mountOnboarding({
      root,
      storage: storageAdapter(),
    });
    handle.start();

    const skipBtn = root.querySelector<HTMLButtonElement>('.onboarding-card__skip');
    skipBtn?.click();

    expect(root.querySelector('.onboarding-card')).toBeNull();
    expect(fakeStorage.get(ONBOARDING_STORAGE_KEY)).toBe('done');
  });

  it('start does not show anything when the storage key is already set', () => {
    fakeStorage.set(ONBOARDING_STORAGE_KEY, 'done');
    handle = mountOnboarding({
      root,
      storage: storageAdapter(),
    });
    handle.start();

    expect(root.querySelector('.onboarding-card')).toBeNull();
  });

  it('runs the sequence when there is no storage at all', () => {
    handle = mountOnboarding({
      root,
      storage: null,
    });
    handle.start();

    const title = root.querySelector('.onboarding-card__title');
    expect(title?.textContent).toBe(ONBOARDING_STEPS[0].title);

    // Finishing without storage must not throw; there is simply nothing to remember.
    const skipBtn = root.querySelector<HTMLButtonElement>('.onboarding-card__skip');
    skipBtn?.click();
    expect(root.querySelector('.onboarding-card')).toBeNull();
  });

  it('focuses the card on each step so the next Tab reaches Skip', () => {
    handle = mountOnboarding({
      root,
      storage: storageAdapter(),
    });
    handle.start();

    const card = root.querySelector<HTMLElement>('.onboarding-card');
    expect(card?.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(card);
  });

  it('keeps the Lights step actionable when the panel starts closed', () => {
    const panel = document.querySelector<HTMLElement>('.lightpanel');
    panel?.setAttribute('hidden', '');
    handle = mountOnboarding({
      root,
      storage: storageAdapter(),
    });
    handle.start();

    const nextBtn = root.querySelector<HTMLButtonElement>('.onboarding-card__next');
    nextBtn?.click();
    nextBtn?.click();

    const card = root.querySelector<HTMLElement>('.onboarding-card');
    expect(card?.querySelector('.onboarding-card__title')?.textContent).toBe('Adjust lighting');
    expect(document.activeElement).toBe(card);
    expect(panel?.hidden).toBe(true);
    expect(document.querySelector('#shell-light-toggle')).not.toBeNull();
  });

  it('complete(id) advances step and fires onDismissed callback', () => {
    const onDismissed = vi.fn();
    handle = mountOnboarding({
      root,
      storage: storageAdapter(),
      onDismissed,
    });
    handle.start();

    const title = root.querySelector<HTMLElement>('.onboarding-card__title');
    expect(title?.textContent).toBe(ONBOARDING_STEPS[0].title);

    // Irrelevant complete call does not advance
    handle.complete('lights');
    expect(title?.textContent).toBe(ONBOARDING_STEPS[0].title);
    expect(onDismissed).not.toHaveBeenCalled();

    // Matching complete call advances
    handle.complete('orbit');
    expect(onDismissed).toHaveBeenCalledWith('orbit');
    expect(title?.textContent).toBe(ONBOARDING_STEPS[1].title);
  });
});
