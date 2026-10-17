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

// The contract tests below each pin one branch of src/ui/onboarding.ts that a fault
// sweep left unguarded on 2026-10-16: the storage error paths, the focus return,
// the anchor wait (hide, observer, poll, cap, supersession) and the card's
// positioning math (fallback box size, per-step offsets, viewport clamps).

const viewportStubs: Array<[string, PropertyDescriptor | undefined]> = [];

function stubViewport(width: number, height: number): void {
  const values: Record<string, number> = { innerWidth: width, innerHeight: height };
  for (const property of ['innerWidth', 'innerHeight'] as const) {
    viewportStubs.push([property, Object.getOwnPropertyDescriptor(window, property)]);
    Object.defineProperty(window, property, { configurable: true, value: values[property] });
  }
}

function uninstallViewport(): void {
  for (const [property, descriptor] of viewportStubs.reverse()) {
    if (descriptor !== undefined) {
      Object.defineProperty(window, property, descriptor);
    } else {
      delete (window as unknown as Record<string, unknown>)[property];
    }
  }
  viewportStubs.length = 0;
}

/** jsdom has no matchMedia, so the reduced-motion query needs an explicit answer. */
function stubMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches }) });
}

function uninstallMatchMedia(): void {
  delete (window as unknown as Record<string, unknown>).matchMedia;
}

function stubRect(
  el: HTMLElement,
  box: { left: number; top: number; right: number; bottom: number },
): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left: box.left,
    top: box.top,
    right: box.right,
    bottom: box.bottom,
    x: box.left,
    y: box.top,
    width: box.right - box.left,
    height: box.bottom - box.top,
    toJSON: () => ({ left: box.left, top: box.top, right: box.right, bottom: box.bottom }),
  });
}

describe('mountOnboarding fault guards', () => {
  const anchorLoopGuards: MutationObserver[] = [];

  /**
   * Bounds a leaked anchor observer: presenting the card probes the DOM with short-lived
   * elements on document.body, so an observer that is never disconnected re-presents on
   * its own probes forever and starves the event loop. Removing the anchor at the first
   * delivery ends the cycle; registered after the guide's own observer, it lets that
   * first (faulty) re-present stay visible to the assertions.
   */
  function removeAnchorWhenDelivered(el: HTMLElement): void {
    const guard = new MutationObserver(() => {
      el.remove();
    });
    guard.observe(document.body, { childList: true, subtree: true });
    anchorLoopGuards.push(guard);
  }

  afterEach(() => {
    for (const guard of anchorLoopGuards.splice(0)) {
      guard.disconnect();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    uninstallViewport();
    uninstallMatchMedia();
  });

  it('adds the reduced-motion class only when the OS asks for less motion', () => {
    stubMatchMedia(true);
    handle = mountOnboarding({ root, storage: storageAdapter() });
    handle.start();
    const card = root.querySelector('.onboarding-card')!;
    expect(card.classList.contains('onboarding-card--reduced-motion')).toBe(true);

    card.remove();
    stubMatchMedia(false);
    handle = mountOnboarding({ root, storage: storageAdapter() });
    handle.start();
    const plainCard = root.querySelector('.onboarding-card')!;
    expect(plainCard.classList.contains('onboarding-card--reduced-motion')).toBe(false);
  });

  it('finishing with a storage that throws still dismisses the card', () => {
    const restricted = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };
    const guide = mountOnboarding({ root, storage: restricted });
    handle = guide;
    guide.start();
    guide.complete('orbit');
    guide.complete('looks');
    expect(() => guide.complete('lights')).not.toThrow();
    expect(root.querySelector('.onboarding-card')).toBeNull();
  });

  it('a restricted storage never stops the sequence from starting', () => {
    const restricted = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => undefined,
    };
    const guide = mountOnboarding({ root, storage: restricted });
    handle = guide;
    expect(() => guide.start()).not.toThrow();
    expect(root.querySelector('.onboarding-card__title')?.textContent)
      .toBe(ONBOARDING_STEPS[0].title);
  });

  it('hands focus back to the element that held it when the sequence started', () => {
    const holder = document.createElement('button');
    document.body.appendChild(holder);
    holder.focus();
    handle = mountOnboarding({ root, storage: storageAdapter() });
    handle.start();
    expect(document.activeElement).toBe(root.querySelector('.onboarding-card'));
    root.querySelector<HTMLButtonElement>('.onboarding-card__skip')!.click();
    expect(document.activeElement).toBe(holder);
    holder.remove();
  });

  it('resolves focus to the body when no element held it and focus drifted', () => {
    // jsdom only honors body.focus() on a focusable body; the browser needs no help.
    document.body.tabIndex = -1;
    handle = mountOnboarding({ root, storage: storageAdapter() });
    handle.start();
    handle.complete('orbit');
    handle.complete('looks');
    const drifter = document.createElement('button');
    document.body.appendChild(drifter);
    drifter.focus();
    handle.complete('lights');
    expect(document.activeElement).toBe(document.body);
    drifter.remove();
    document.body.removeAttribute('tabindex');
  });

  it('a retained Next control cannot restart the sequence after it finishes', () => {
    handle = mountOnboarding({ root, storage: storageAdapter() });
    handle.start();
    const next = root.querySelector<HTMLButtonElement>('.onboarding-card__next')!;
    next.click();
    next.click();
    next.click();
    expect(root.querySelector('.onboarding-card')).toBeNull();
    next.click();
    expect(root.querySelector('.onboarding-card')).toBeNull();
  });

  describe('anchor wait', () => {
    it('hides the card while the step waits for its anchor', () => {
      document.getElementById('looks')?.remove();
      handle = mountOnboarding({ root, storage: storageAdapter() });
      handle.start();
      handle.complete('orbit');
      const card = root.querySelector<HTMLElement>('.onboarding-card')!;
      expect(card.hidden).toBe(true);
      expect(card.querySelector('.onboarding-card__title')?.textContent).toBe('Select a look');
    });

    it('presents the step when the anchor appears in the DOM', async () => {
      vi.useFakeTimers();
      document.getElementById('looks')?.remove();
      const looks = document.createElement('nav');
      handle = mountOnboarding({ root, storage: storageAdapter() });
      handle.start();
      handle.complete('orbit');
      removeAnchorWhenDelivered(looks);
      const card = root.querySelector<HTMLElement>('.onboarding-card')!;
      expect(card.hidden).toBe(true);
      looks.id = 'looks';
      document.body.appendChild(looks);
      // Flush the MutationObserver delivery without reaching the 100 ms poll tick.
      await vi.advanceTimersByTimeAsync(0);
      expect(card.hidden).toBe(false);
      expect(card.querySelector('.onboarding-card__title')?.textContent).toBe('Select a look');
    });

    it('presents the step when an existing element becomes the anchor', () => {
      vi.useFakeTimers();
      document.getElementById('looks')?.remove();
      const looks = document.createElement('nav');
      document.body.appendChild(looks);
      handle = mountOnboarding({ root, storage: storageAdapter() });
      handle.start();
      handle.complete('orbit');
      removeAnchorWhenDelivered(looks);
      // An attribute change is invisible to the childList observer; only the poll
      // re-queries the selector.
      looks.id = 'looks';
      vi.advanceTimersByTime(150);
      const card = root.querySelector<HTMLElement>('.onboarding-card')!;
      expect(card.hidden).toBe(false);
      expect(card.querySelector('.onboarding-card__title')?.textContent).toBe('Select a look');
    });

    it('stops waiting for the anchor after the fallback cap', () => {
      vi.useFakeTimers();
      document.getElementById('looks')?.remove();
      const looks = document.createElement('nav');
      document.body.appendChild(looks);
      handle = mountOnboarding({ root, storage: storageAdapter() });
      handle.start();
      handle.complete('orbit');
      removeAnchorWhenDelivered(looks);
      // 50 attempts at a 100 ms cadence: the fallback wait has given up by 5 s.
      vi.advanceTimersByTime(5300);
      looks.id = 'looks';
      vi.advanceTimersByTime(400);
      const card = root.querySelector<HTMLElement>('.onboarding-card')!;
      expect(card.hidden).toBe(true);
    });

    it('a superseded anchor wait never re-presents its step', () => {
      vi.useFakeTimers();
      stubViewport(1200, 390);
      document.getElementById('looks')?.remove();
      const toggle = document.getElementById('shell-light-toggle')!;
      stubRect(toggle, { left: 760, top: 300, right: 830, bottom: 374 });
      const looks = document.createElement('nav');
      stubRect(looks, { left: 700, top: 40, right: 830, bottom: 350 });
      handle = mountOnboarding({ root, storage: storageAdapter() });
      handle.start();
      handle.complete('orbit');
      removeAnchorWhenDelivered(looks);
      root.querySelector<HTMLButtonElement>('.onboarding-card__next')!.click();
      looks.id = 'looks';
      document.body.appendChild(looks);
      vi.advanceTimersByTime(300);
      const card = root.querySelector<HTMLElement>('.onboarding-card')!;
      expect(card.querySelector('.onboarding-card__title')?.textContent).toBe('Adjust lighting');
      expect(card.style.getPropertyValue('--onboarding-x')).toBe('760px');
    });

    it('a finished anchor wait stays silent when the anchor appears later', async () => {
      vi.useFakeTimers();
      document.getElementById('looks')?.remove();
      const looks = document.createElement('nav');
      handle = mountOnboarding({ root, storage: storageAdapter() });
      handle.start();
      handle.complete('orbit');
      removeAnchorWhenDelivered(looks);
      root.querySelector<HTMLButtonElement>('.onboarding-card__skip')!.click();
      expect(root.querySelector('.onboarding-card')).toBeNull();
      looks.id = 'looks';
      document.body.appendChild(looks);
      await vi.advanceTimersByTimeAsync(0);
      expect(root.querySelector('.onboarding-card')).toBeNull();
    });
  });

  describe('card positioning', () => {
    it('clamps the Looks card inside the viewport using the fallback card width', () => {
      stubViewport(844, 390);
      stubRect(document.getElementById('looks')!, {
        left: 700, top: 40, right: 830, bottom: 350,
      });
      handle = mountOnboarding({ root, storage: storageAdapter() });
      handle.start();
      handle.complete('orbit');
      const card = root.querySelector<HTMLElement>('.onboarding-card')!;
      expect(card.style.getPropertyValue('--onboarding-x')).toBe('548px');
    });

    it('offsets the Looks card right of the rail', () => {
      stubViewport(844, 390);
      stubRect(document.getElementById('looks')!, {
        left: 388, top: 40, right: 400, bottom: 350,
      });
      handle = mountOnboarding({ root, storage: storageAdapter() });
      handle.start();
      handle.complete('orbit');
      const card = root.querySelector<HTMLElement>('.onboarding-card')!;
      expect(card.style.getPropertyValue('--onboarding-x')).toBe('412px');
    });

    it('places the Lights card above the launcher using the fallback card height', () => {
      stubViewport(844, 390);
      stubRect(document.getElementById('shell-light-toggle')!, {
        left: 760, top: 300, right: 830, bottom: 374,
      });
      handle = mountOnboarding({ root, storage: storageAdapter() });
      handle.start();
      handle.complete('orbit');
      handle.complete('looks');
      const card = root.querySelector<HTMLElement>('.onboarding-card')!;
      expect(card.style.getPropertyValue('--onboarding-y')).toBe('168px');
    });

    it('clamps the Orbit card inside the viewport height', () => {
      stubViewport(844, 390);
      stubRect(document.getElementById('scene')!, {
        left: 100, top: 0, right: 944, bottom: 600,
      });
      handle = mountOnboarding({ root, storage: storageAdapter() });
      handle.start();
      const card = root.querySelector<HTMLElement>('.onboarding-card')!;
      expect(card.style.getPropertyValue('--onboarding-y')).toBe('254px');
    });

    it('offsets the Orbit card clear of the scene anchor', () => {
      stubViewport(844, 390);
      stubRect(document.getElementById('scene')!, {
        left: 100, top: 0, right: 944, bottom: 600,
      });
      handle = mountOnboarding({ root, storage: storageAdapter() });
      handle.start();
      const card = root.querySelector<HTMLElement>('.onboarding-card')!;
      expect(card.style.getPropertyValue('--onboarding-x')).toBe('180px');
    });
  });
});
