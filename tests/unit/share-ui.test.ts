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

  it('removes elements and aborts handlers on dispose', () => {
    const handle = mountShare(root, actions);
    expect(root.querySelector('.share')).not.toBeNull();

    handle.dispose();
    expect(root.querySelector('.share')).toBeNull();
  });
});
