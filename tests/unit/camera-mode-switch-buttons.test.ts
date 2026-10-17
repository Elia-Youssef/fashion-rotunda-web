// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { make, root } from '../support/camera-mode-switch';

// The Orbit and Walk control surface: button order, labels, tooltips, aria-pressed, the
// loading and retry states, and the click guards around a pending or failed switch.

describe('mountModeSwitch', () => {
  it('mounts Orbit and Walk buttons with aria-pressed on the active one', () => {
    const { handle } = make('orbit');
    const orbit = root.querySelector('button[data-mode="orbit"]') as HTMLButtonElement;
    const walk = root.querySelector('button[data-mode="walk"]') as HTMLButtonElement;

    expect(orbit).not.toBeNull();
    expect(walk).not.toBeNull();
    expect(orbit.getAttribute('aria-pressed')).toBe('true');
    expect(walk.getAttribute('aria-pressed')).toBe('false');

    handle.dispose();
  });

  it('keeps Walk usable during the transitional boot preload', () => {
    const { handle, triggerWalkReady } = make('orbit', false);
    const walk = root.querySelector('button[data-mode="walk"]') as HTMLButtonElement;

    expect(walk.disabled).toBe(false);
    expect(walk.getAttribute('data-tooltip')).toBe('Walk the showroom floor');

    triggerWalkReady();
    expect(walk.disabled).toBe(false);
    expect(walk.getAttribute('data-tooltip')).toBe('Walk the showroom floor');

    handle.dispose();
  });

  it.each([
    ['idle', null, 'idle', 'Walk'],
    ['loading', 'walk', 'loading', 'Loading Walk...'],
    ['failed', null, 'error', 'Retry Walk'],
  ] as const)('keeps the exact label and action tooltip in the %s state', (_state, pending, load, label) => {
    const { handle, triggerState } = make('orbit', false);
    try {
      triggerState(pending, load);
      const walk = root.querySelector<HTMLButtonElement>('[data-mode="walk"]')!;
      expect(walk.textContent).toBe(label);
      expect(walk.getAttribute('aria-label')).toBe(label);
      expect(walk.getAttribute('data-tooltip')).toBe('Walk the showroom floor');
      // Reservation is generated content, so other labels never enter the button's DOM text.
      expect(walk.getAttribute('data-reserve-labels')).toBe('Walk\nLoading Walk...\nRetry Walk');
      expect(walk.querySelectorAll('.archviz-mode-label')).toHaveLength(1);
      expect(walk.querySelector('.archviz-mode-label')?.textContent).toBe(label);
      const hint = document.body.querySelector<HTMLElement>('.archviz-walk-hint')!;
      expect(hint.hidden).toBe(load !== 'error');
      if (load === 'error') expect(hint.textContent).toBe('Walk could not load. Try again.');
    } finally { handle.dispose(); }
  });

  it('keeps focus while loading, guards duplicate clicks and explicitly cancels from Orbit', async () => {
    const { mount, handle, triggerState } = make('orbit', false);
    const walk = root.querySelector<HTMLButtonElement>('[data-mode="walk"]')!;
    const orbit = root.querySelector<HTMLButtonElement>('[data-mode="orbit"]')!;
    vi.mocked(mount.setMode).mockImplementation(async (mode) => {
      triggerState(mode === 'walk' ? 'walk' : null, mode === 'walk' ? 'loading' : 'idle');
    });
    walk.focus();
    walk.click();
    expect(walk.textContent).toBe('Loading Walk...');
    expect(walk.getAttribute('aria-disabled')).toBe('true');
    expect(walk.disabled).toBe(false);
    expect(document.activeElement).toBe(walk);
    expect(root.querySelector('nav')?.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector('.a11y-live-region')?.closest('[aria-busy="true"]')).toBeNull();
    expect(walk.getAttribute('aria-pressed')).toBe('false');
    expect(orbit.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('.a11y-live-region')?.textContent).toBe('Loading Walk...');
    walk.click();
    expect(mount.setMode).toHaveBeenCalledTimes(1);
    orbit.click();
    expect(mount.setMode).toHaveBeenLastCalledWith('orbit');
    expect(walk.textContent).toBe('Walk');
    expect(walk.getAttribute('aria-disabled')).toBe('false');
    expect(root.querySelector('nav')?.getAttribute('aria-busy')).toBe('false');
    handle.dispose();
    await Promise.resolve();
  });

  it('shows a visible retry and a separate polite failure notice without stealing focus', async () => {
    const { mount, handle, triggerState } = make();
    const unrelated = document.createElement('div');
    unrelated.textContent = 'Experience ready';
    root.appendChild(unrelated);
    const walk = root.querySelector<HTMLButtonElement>('[data-mode="walk"]')!;
    vi.mocked(mount.setMode).mockImplementation(async () => {
      triggerState(null, 'error');
      throw new Error('load failed');
    });
    walk.focus();
    walk.click();
    await Promise.resolve();
    expect(document.activeElement).toBe(walk);
    expect(walk.textContent).toBe('Retry Walk');
    expect(walk.getAttribute('data-tooltip')).toBe('Walk the showroom floor');
    const notice = document.body.querySelector<HTMLElement>('.archviz-walk-hint')!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe('Walk could not load. Try again.');
    const region = root.querySelector('.a11y-live-region');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.textContent).toBe('Walk could not load. Try again.');
    expect(unrelated.textContent).toBe('Experience ready');
    walk.click();
    await Promise.resolve();
    expect(mount.setMode).toHaveBeenCalledTimes(2);
    handle.dispose();
    expect(document.body.querySelector('.archviz-walk-hint')).toBeNull();
    expect(root.querySelector('.a11y-live-region')).not.toBeNull();
  });

  it('keeps Orbit selectable after Walk has released the mouse', async () => {
    const { mount, handle } = make('walk', true);
    const orbit = root.querySelector('button[data-mode="orbit"]') as HTMLButtonElement;

    orbit.click();
    expect(mount.setMode).toHaveBeenCalledWith('orbit');

    handle.dispose();
  });

  it('updates aria-pressed when mode changes externally', () => {
    const { mount, handle } = make('orbit', true);
    const orbit = root.querySelector('button[data-mode="orbit"]') as HTMLButtonElement;
    const walk = root.querySelector('button[data-mode="walk"]') as HTMLButtonElement;

    // Simulate mode change.
    void mount.setMode('walk');
    expect(orbit.getAttribute('aria-pressed')).toBe('false');
    expect(walk.getAttribute('aria-pressed')).toBe('true');

    handle.dispose();
  });

  it('does not request Walk again while Walk already owns the camera', () => {
    const { mount, handle } = make('walk', true);
    const walk = root.querySelector<HTMLButtonElement>('[data-mode="walk"]')!;

    walk.click();

    expect(mount.setMode).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('lists Orbit before Walk and mounts the hint on the page body', () => {
    const { handle } = make('walk');
    const nav = root.querySelector('nav')!;
    const hint = document.body.querySelector<HTMLElement>('.archviz-walk-hint')!;

    expect(Array.from(nav.children).map((child) => child.getAttribute('data-mode')))
      .toEqual(['orbit', 'walk']);
    expect(hint.parentElement).toBe(document.body);

    handle.dispose();
  });
});
