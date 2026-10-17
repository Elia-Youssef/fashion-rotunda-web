// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountAnnouncer, mountPageAnnouncer, prefersReducedMotion } from '../../src/ui/announce';
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

    announcer.say('Mannequin: Dark charcoal');
    expect(region.textContent).toBe('Mannequin: Dark charcoal');
    const firstTextNode = region.firstChild;

    // The window has to close before a second message is spoken at all.
    vi.advanceTimersByTime(500);
    announcer.say('Mannequin: Dark charcoal');

    expect(region.textContent).toBe('Mannequin: Dark charcoal');
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

  it('keeps disposal idempotent and ignores late messages without restarting a timer', () => {
    announcer = mountAnnouncer(root);
    const region = root.querySelector('.a11y-live-region')!;
    announcer.say('First');
    announcer.say('Queued');
    announcer.dispose();
    announcer.dispose();
    announcer.say('Late');
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    expect(region.textContent).toBe('First');
    expect(root.querySelector('.a11y-live-region')).toBeNull();
  });

  it('holds a message that arrives inside the window reopened by a spoken tail', () => {
    announcer = mountAnnouncer(root);
    const region = root.querySelector('.a11y-live-region')!;

    announcer.say('First');
    announcer.say('Second');
    vi.advanceTimersByTime(500);
    expect(region.textContent).toBe('Second');

    // The tail message reopened the coalescing window, so the next one waits inside it.
    announcer.say('Third');
    expect(region.textContent).toBe('Second');
    vi.advanceTimersByTime(499);
    expect(region.textContent).toBe('Second');
    vi.advanceTimersByTime(1);
    expect(region.textContent).toBe('Third');
  });
});

describe('mountPageAnnouncer', () => {
  it('retains one region and its coalescing window through a back-forward cache departure', () => {
    announcer = mountPageAnnouncer(root);
    const region = root.querySelector('.a11y-live-region');
    announcer.say('Before cache');
    announcer.say('Pending');
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(root.querySelectorAll('.a11y-live-region')).toHaveLength(1);
    expect(root.querySelector('.a11y-live-region')).toBe(region);
    vi.advanceTimersByTime(500);
    expect(region?.textContent).toBe('Pending');
  });

  it('disposes on permanent pagehide and releases its lifecycle listener', () => {
    announcer = mountPageAnnouncer(root);
    const remove = vi.spyOn(window, 'removeEventListener');
    announcer.say('Before departure');
    announcer.say('Pending');
    // A synthetic lifecycle notification used by diagnostics is not a real page departure.
    window.dispatchEvent(new Event('pagehide'));
    expect(root.querySelectorAll('.a11y-live-region')).toHaveLength(1);
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    expect(root.querySelector('.a11y-live-region')).toBeNull();
    expect(remove).toHaveBeenCalledWith('pagehide', expect.any(Function));
    announcer.say('After departure');
    announcer.dispose();
    expect(vi.getTimerCount()).toBe(0);
    remove.mockRestore();
  });
});

describe('prefersReducedMotion', () => {
  it('returns a boolean based on matchMedia', () => {
    const value = prefersReducedMotion();
    expect(typeof value).toBe('boolean');
  });

  it('reports false without matchMedia and follows the query result with it', () => {
    // jsdom ships no matchMedia, so the unavailable-environment guard is the live path here.
    expect(typeof window.matchMedia).toBe('undefined');
    expect(prefersReducedMotion()).toBe(false);

    const media = window as unknown as {
      matchMedia?: ((query: string) => { matches: boolean }) | undefined;
    };
    try {
      media.matchMedia = () => ({ matches: true });
      expect(prefersReducedMotion()).toBe(true);
      media.matchMedia = () => ({ matches: false });
      expect(prefersReducedMotion()).toBe(false);
    } finally {
      media.matchMedia = undefined;
    }
    expect(prefersReducedMotion()).toBe(false);
  });
});
