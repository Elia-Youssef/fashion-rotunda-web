// Polite live region for screen readers. The first message is spoken at once and opens a 500 ms
// window; messages arriving inside the window replace one another and the survivor is spoken when
// it closes. A trailing delay on every message would hold back the one announcement a visitor is
// waiting for, and a queue would read a burst of swatch changes out one by one.

import './announce.css';

export interface Announcer {
  /** Polite live region; coalesces messages within 500 ms into the last one. */
  say(text: string): void;
  dispose(): void;
}

/** The floor between two spoken messages, in milliseconds. */
const WINDOW_MS = 500;

/** Reports whether the operating system or browser requests reduced motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function mountAnnouncer(root: HTMLElement): Announcer {
  const region = document.createElement('div');
  region.className = 'a11y-live-region';
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  root.appendChild(region);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingText: string | null = null;

  function speak(text: string): void {
    // Writing the same string a second time is not a change, so the region would stay silent.
    // Clearing first makes the repeat a real mutation, which is what the reader watches for.
    region.textContent = '';
    region.textContent = text;
  }

  function openWindow(): void {
    timer = setTimeout(() => {
      timer = null;
      if (pendingText !== null) {
        const next = pendingText;
        pendingText = null;
        speak(next);
        // A message spoken at the end of a window opens the next one, so the floor still holds.
        openWindow();
      }
    }, WINDOW_MS);
  }

  return {
    say(text: string): void {
      if (timer === null) {
        speak(text);
        openWindow();
        return;
      }
      pendingText = text;
    },
    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pendingText = null;
      region.remove();
    },
  };
}
