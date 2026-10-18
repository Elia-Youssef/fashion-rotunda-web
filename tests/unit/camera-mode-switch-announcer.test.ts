// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { announcer, canvas, make, root } from '../support/camera-mode-switch';
import { mountA11y } from '../../src/ui/a11y';

// Announcements through the live region shared with the accessibility layer: one region under
// two mounted layers, once-only delivery through the shared coalescing window, and guidance
// speech that repeats only when the hint becomes visible again.

describe('mountModeSwitch', () => {
  it.each(['camera-first', 'a11y-first'] as const)(
    'shares one page region with both layers mounted %s and preserves it across borrower disposal',
    async (order) => {
      const region = root.querySelector('.a11y-live-region');
      const disposeOwner = vi.spyOn(announcer, 'dispose');
      const aside = document.createElement('aside');
      root.appendChild(aside);
      expect(root.querySelectorAll('.a11y-live-region')).toHaveLength(1);
      const a11y = order === 'a11y-first'
        ? mountA11y({ root, aside, canvas, search: '?e2e=1', announcer }) : null;
      const mode = make();
      const access = a11y ?? mountA11y({ root, aside, canvas, search: '?e2e=1', announcer });
      try {
        expect(root.querySelectorAll('.a11y-live-region')).toHaveLength(1);
        expect(root.querySelector('.a11y-live-region')).toBe(region);
        expect(access.announcer).toBe(announcer);
        if (order === 'camera-first') {
          mode.handle.dispose();
          canvas.dataset.variant = 'dark';
          await Promise.resolve();
          expect(region?.textContent).toBe('Mannequin: Dark charcoal');
        } else {
          access.dispose();
          mode.triggerState(null, 'error');
          expect(region?.textContent).toBe('Walk could not load. Try again.');
        }
        access.dispose();
        access.dispose();
        mode.handle.dispose();
        expect(disposeOwner).not.toHaveBeenCalled();
        expect(root.querySelectorAll('.a11y-live-region')).toHaveLength(1);
        announcer.dispose();
        expect(root.querySelector('.a11y-live-region')).toBeNull();
      } finally {
        mode.handle.dispose();
        access.dispose();
      }
    },
  );

  it('announces a failed Walk exactly once through the shared channel with both layers mounted', async () => {
    vi.useFakeTimers();
    const aside = document.createElement('aside');
    root.appendChild(aside);
    const mode = make();
    const access = mountA11y({ root, aside, canvas, search: '?e2e=1', announcer });
    const region = root.querySelector('.a11y-live-region')!;
    const say = vi.spyOn(announcer, 'say');
    const spoken: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node.textContent) spoken.push(node.textContent);
      }
    });
    observer.observe(region, { childList: true });
    try {
      mode.triggerState('walk', 'loading');
      mode.triggerState(null, 'error');
      mode.triggerState(null, 'error');
      // The shared coalescing window owns delivery; fake time tests that contract without a sleep.
      await vi.advanceTimersByTimeAsync(500);
      const notice = 'Walk could not load. Try again.';
      expect(say.mock.calls.filter(([text]) => text === notice)).toHaveLength(1);
      expect(spoken.filter((text) => text === notice)).toHaveLength(1);
      const channels = [...document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')]
        .filter((element) => element.textContent === notice);
      expect(channels).toEqual([region]);
      const hint = document.body.querySelector<HTMLElement>('.archviz-walk-hint')!;
      expect(hint.hidden).toBe(false);
      expect(hint.textContent).toBe(notice);
      expect(hint.hasAttribute('aria-live')).toBe(false);
    } finally {
      observer.disconnect();
      mode.handle.dispose();
      access.dispose();
      announcer.dispose();
      vi.useRealTimers();
    }
  });

  it('speaks pointer-lock escape guidance once each time it becomes visible', async () => {
    const mode = make();
    const say = vi.spyOn(announcer, 'say');
    try {
      await mode.mount.setMode('walk');
      mode.triggerState(null, 'ready');
      mode.triggerState(null, 'ready');
      const hint = document.body.querySelector<HTMLElement>('.archviz-walk-hint')!;
      const guidance =
        'Walk: click the scene to look. Move with W A S D or the arrow keys; hold Shift to walk faster. ' +
        'Press Esc to release the mouse, then select Orbit. Press O to return to Orbit.';
      expect(hint.hidden).toBe(false);
      expect(hint.hasAttribute('aria-live')).toBe(false);
      expect(say.mock.calls.filter(([text]) => text === guidance)).toHaveLength(1);
      await mode.mount.setMode('orbit');
      await mode.mount.setMode('walk');
      expect(say.mock.calls.filter(([text]) => text === guidance)).toHaveLength(2);
    } finally { mode.handle.dispose(); }
  });
});
