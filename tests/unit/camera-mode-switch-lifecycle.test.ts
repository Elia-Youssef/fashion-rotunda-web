// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { announcer, canvas, make, root } from '../support/camera-mode-switch';
import { mountModeSwitch } from '../../src/camera/mode-switch';
import type { ModeSwitchMount } from '../../src/camera/mode-switch';
import type { WalkLoadState } from '../../src/camera/contracts';
import type { CameraMode } from '../../src/camera/mount';

// Disposal and failure containment: controls and the O shortcut stop at disposal, external
// mode changes no longer move a retired switch, and rejected switches never surface as
// unhandled rejections or take the shared announcements down with them.

describe('mountModeSwitch', () => {
  it('catches a rejected O command and removes own listeners without disposing shared announcements', async () => {
    vi.useFakeTimers();
    try {
      const disposeOwner = vi.spyOn(announcer, 'dispose');
      const { mount, handle, triggerState } = make('walk');
      vi.mocked(mount.setMode).mockRejectedValue(new Error('command failed'));
      canvas.focus();
      canvas.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true }));
      await Promise.resolve();
      triggerState('walk', 'loading');
      triggerState(null, 'error');
      const retiredWalk = root.querySelector<HTMLButtonElement>('[data-mode="walk"]')!;
      const retiredLabel = retiredWalk.textContent;
      handle.dispose();
      handle.dispose();
      expect(disposeOwner).not.toHaveBeenCalled();
      expect(root.querySelector('.a11y-live-region')).not.toBeNull();
      triggerState('walk', 'loading');
      expect(retiredWalk.textContent).toBe(retiredLabel);
      announcer.dispose();
      expect(disposeOwner).toHaveBeenCalledOnce();
      await vi.runAllTimersAsync();
      expect(document.body.querySelector('.archviz-walk-hint')).toBeNull();
      expect(root.querySelector('nav')).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      expect(mount.setMode).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('keeps a failed mode click from surfacing as an unhandled rejection', async () => {
    // A vi.fn setMode marks its rejected return value handled, which would mask the
    // very leak this test watches for, so this mount uses plain functions.
    const mount: ModeSwitchMount = {
      get mode(): CameraMode { return 'orbit'; },
      setMode: async () => { throw new Error('switch failed'); },
      onModeChange: () => () => {},
      get pendingMode() { return null; },
      get walkLoadState(): WalkLoadState { return 'ready'; },
      onWalkStateChange: () => () => {},
    };
    const handle = mountModeSwitch(root, mount, { canvas, announcer });
    const walk = root.querySelector<HTMLButtonElement>('[data-mode="walk"]')!;
    const orbit = root.querySelector<HTMLButtonElement>('[data-mode="orbit"]')!;
    const rejections: unknown[] = [];
    const record = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', record);
    try {
      walk.click();
      orbit.click();
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', record);
      handle.dispose();
    }
  });

  it('stops click input at disposal', () => {
    // Orbit mode: both buttons pass their click guards, so a surviving listener
    // after disposal reaches setMode (in Walk mode the mode guard would mask it).
    const { mount, handle } = make('orbit');
    const orbit = root.querySelector<HTMLButtonElement>('[data-mode="orbit"]')!;
    const walk = root.querySelector<HTMLButtonElement>('[data-mode="walk"]')!;

    handle.dispose();
    orbit.click();
    walk.click();

    expect(mount.setMode).not.toHaveBeenCalled();
  });

  it('stops the O shortcut at disposal', () => {
    const { mount, handle } = make('walk');
    canvas.focus();

    handle.dispose();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true, cancelable: true }));

    expect(mount.setMode).not.toHaveBeenCalled();
  });

  it('ignores external mode changes after disposal', async () => {
    const { mount, handle } = make('orbit');
    const walk = root.querySelector<HTMLButtonElement>('[data-mode="walk"]')!;

    handle.dispose();
    await mount.setMode('walk');

    expect(walk.getAttribute('aria-pressed')).toBe('false');
  });
});
