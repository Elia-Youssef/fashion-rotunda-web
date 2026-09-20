// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountAnnouncer, prefersReducedMotion } from '../../src/ui/announce';
import type { Announcer } from '../../src/ui/announce';

let root: HTMLElement;
let announcer: Announcer | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  announcer?.dispose();
  announcer = null;
  root.remove();
  vi.useRealTimers();
});

describe('mountAnnouncer', () => {
  it('mounts a polite live region with aria-atomic true', () => {
    announcer = mountAnnouncer(root);
    const region = root.querySelector('.a11y-live-region');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.getAttribute('aria-atomic')).toBe('true');
  });

  it('speaks the first message at once, with no window open', () => {
    announcer = mountAnnouncer(root);
    const region = root.querySelector('.a11y-live-region');

    announcer.say('First message');
    expect(region?.textContent).toBe('First message');
  });

  it('coalesces rapid messages within 500 ms into the last one', () => {
    announcer = mountAnnouncer(root);
    const region = root.querySelector('.a11y-live-region');

    announcer.say('First message');
    announcer.say('Second message');
    announcer.say('Third message');

    // The first one is spoken at once; the other two replace one another inside the window.
    expect(region?.textContent).toBe('First message');

    vi.advanceTimersByTime(499);
    expect(region?.textContent).toBe('First message');

    vi.advanceTimersByTime(1);
    expect(region?.textContent).toBe('Third message');
  });

  it('speaks a repeated string again', () => {
    announcer = mountAnnouncer(root);
    const region = root.querySelector<HTMLDivElement>('.a11y-live-region');
    if (region === null) {
      throw new Error('the live region is missing');
    }

    announcer.say('Mannequin: dark');
    expect(region.textContent).toBe('Mannequin: dark');
    const firstTextNode = region.firstChild;

    // The window has to close before a second message is spoken at all.
    vi.advanceTimersByTime(500);
    announcer.say('Mannequin: dark');

    expect(region.textContent).toBe('Mannequin: dark');
    // Clearing before the write replaces the text node, which is the mutation a reader watches
    // for. Writing the identical string onto the same node would announce nothing.
    expect(region.firstChild).not.toBe(firstTextNode);
  });

  it('announces subsequent messages after the 500 ms window', () => {
    announcer = mountAnnouncer(root);
    const region = root.querySelector('.a11y-live-region');

    announcer.say('Initial');
    expect(region?.textContent).toBe('Initial');

    announcer.say('Subsequent');
    vi.advanceTimersByTime(500);
    expect(region?.textContent).toBe('Subsequent');
  });

  it('dispose clears any pending timer and removes the region', () => {
    announcer = mountAnnouncer(root);
    announcer.say('Pending message');
    announcer.dispose();
    announcer = null;

    vi.advanceTimersByTime(500);
    expect(root.querySelector('.a11y-live-region')).toBeNull();
  });
});

describe('prefersReducedMotion', () => {
  it('returns a boolean based on matchMedia', () => {
    const value = prefersReducedMotion();
    expect(typeof value).toBe('boolean');
  });
});
