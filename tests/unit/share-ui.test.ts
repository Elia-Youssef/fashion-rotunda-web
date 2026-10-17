// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountShare } from '../../src/ui/share';
import type { ShareActions } from '../../src/ui/share';

describe('share UI component', () => {
  let root: HTMLElement;
  let actions: ShareActions;

  beforeEach(() => {
    vi.useFakeTimers();
    root = document.createElement('aside');
    document.body.appendChild(root);
    actions = {
      copyLink: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => undefined),
    };
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    root.remove();
  });

  it('mounts into the root element when no product-card is present', () => {
    const handle = mountShare(root, actions);
    const container = root.querySelector('.share');
    expect(container).not.toBeNull();
    expect(root.contains(container)).toBe(true);
    handle.dispose();
  });

  it('inserts directly after .product-card when present', () => {
    const card = document.createElement('div');
    card.className = 'product-card';
    root.appendChild(card);

    const following = document.createElement('div');
    following.className = 'following';
    root.appendChild(following);

    const handle = mountShare(root, actions);
    const share = root.querySelector('.share');
    expect(card.nextElementSibling).toBe(share);
    expect(share?.nextElementSibling).toBe(following);
    handle.dispose();
  });

  it('falls back to the end of the root when the product-card is not a direct child', () => {
    const wrapper = document.createElement('div');
    const card = document.createElement('div');
    card.className = 'product-card';
    wrapper.appendChild(card);
    root.appendChild(wrapper);

    const handle = mountShare(root, actions);
    const share = root.querySelector('.share');
    expect(share?.parentElement).toBe(root);
    expect(root.lastElementChild).toBe(share);
    expect(card.nextElementSibling).toBeNull();
    handle.dispose();
  });

  it('forwards button clicks to actions', () => {
    const handle = mountShare(root, actions);
    const copyBtn = root.querySelector<HTMLButtonElement>('.share__button--copy');
    const screenshotBtn = root.querySelector<HTMLButtonElement>('.share__button--screenshot');

    expect(copyBtn).not.toBeNull();
    expect(screenshotBtn).not.toBeNull();

    copyBtn?.click();
    expect(actions.copyLink).toHaveBeenCalledTimes(1);

    screenshotBtn?.click();
    expect(actions.screenshot).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('labels both actions and the hidden fallback input for the visitor', () => {
    const handle = mountShare(root, actions);
    const copy = root.querySelector<HTMLButtonElement>('.share__button--copy')!;
    const screenshot = root.querySelector<HTMLButtonElement>('.share__button--screenshot')!;
    expect(copy.textContent).toBe('Copy link');
    expect(screenshot.textContent).toBe('Screenshot');

    const fallback = root.querySelector<HTMLInputElement>('input.share__fallback');
    expect(fallback).not.toBeNull();
    expect(fallback?.className).toContain('share__fallback--hidden');
    expect(fallback?.readOnly).toBe(true);
    expect(fallback?.getAttribute('aria-label')).toBe('Shareable link');
    handle.dispose();
  });

  it('shows confirmation notification and clears it after 2000 ms', () => {
    const handle = mountShare(root, actions);
    const status = root.querySelector<HTMLElement>('.share__status');
    expect(status?.textContent).toBe('');

    handle.notify('Link copied');
    expect(status?.textContent).toBe('Link copied');

    vi.advanceTimersByTime(1999);
    expect(status?.textContent).toBe('Link copied');

    vi.advanceTimersByTime(1);
    expect(status?.textContent).toBe('');

    handle.dispose();
  });

  it('publishes notifications through a polite live region', () => {
    const handle = mountShare(root, actions);
    const status = root.querySelector<HTMLElement>('.share__status')!;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    handle.dispose();
  });

  it('restarts the two-second window when a second notification arrives', () => {
    const handle = mountShare(root, actions);
    const status = root.querySelector<HTMLElement>('.share__status')!;

    handle.notify('Link copied');
    vi.advanceTimersByTime(1000);
    handle.notify('Still saved');
    expect(status.textContent).toBe('Still saved');

    // The first window is gone: only the second one decides when the text clears.
    vi.advanceTimersByTime(1000);
    expect(status.textContent).toBe('Still saved');

    vi.advanceTimersByTime(1000);
    expect(status.textContent).toBe('');
    handle.dispose();
  });

  it('removes elements and aborts handlers on dispose', () => {
    const handle = mountShare(root, actions);
    expect(root.querySelector('.share')).not.toBeNull();

    handle.dispose();
    expect(root.querySelector('.share')).toBeNull();
  });

  it('keeps notifications and retained controls inert after disposal', () => {
    const handle = mountShare(root, actions);
    const status = root.querySelector<HTMLElement>('.share__status')!;
    const copy = root.querySelector<HTMLButtonElement>('.share__button--copy')!;
    const screenshot = root.querySelector<HTMLButtonElement>('.share__button--screenshot')!;
    handle.notify('Before disposal');
    handle.dispose();
    expect(vi.getTimerCount()).toBe(0);
    handle.notify('After disposal');
    copy.click();
    screenshot.click();
    expect(status.textContent).toBe('Before disposal');
    expect(vi.getTimerCount()).toBe(0);
    expect(actions.copyLink).not.toHaveBeenCalled();
    expect(actions.screenshot).not.toHaveBeenCalled();
  });
});
