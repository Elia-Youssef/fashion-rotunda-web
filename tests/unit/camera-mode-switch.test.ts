// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountA11y } from '../../src/ui/a11y';
import { mountAnnouncer } from '../../src/ui/announce';
import type { Announcer } from '../../src/ui/announce';
import { mountModeSwitch } from '../../src/camera/mode-switch';
import type { ModeSwitchMount } from '../../src/camera/mode-switch';
import type { WalkLoadState } from '../../src/camera/contracts';
import type { CameraMode } from '../../src/camera/mount';

describe('mountModeSwitch', () => {
  let root: HTMLElement;
  let announcer: Announcer;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
    announcer = mountAnnouncer(root);
    canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    root.appendChild(canvas);
    // jsdom does not implement pointer lock; model the browser-owned getter explicitly.
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => null });
  });

  afterEach(() => {
    announcer.dispose();
    root.remove();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, 'pointerLockElement');
  });

  function make(
    initialMode: CameraMode = 'orbit',
    walkReady = true,
    hasPointerLock?: boolean,
  ) {
    let mode = initialMode;
    const listeners = new Set<(m: CameraMode) => void>();
    const readyListeners = new Set<() => void>();
    let pendingMode: CameraMode | null = null;
    let walkLoadState: WalkLoadState = walkReady ? 'ready' : 'loading';

    const mount: ModeSwitchMount = {
      get mode(): CameraMode {
        return mode;
      },
      setMode: vi.fn(async (m: CameraMode) => {
        mode = m;
        for (const l of listeners) {
          l(m);
        }
      }),
      onModeChange: vi.fn((listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      get pendingMode() { return pendingMode; },
      get walkLoadState() { return walkLoadState; },
      onWalkStateChange: vi.fn((listener) => {
        readyListeners.add(listener);
        return () => readyListeners.delete(listener);
      }),
    };

    // exactOptionalPropertyTypes: omit the key (rather than pass undefined) so the
    // module's own default decides pointer-lock ownership when the option is absent.
    const handle = mountModeSwitch(
      root,
      mount,
      hasPointerLock === undefined ? { canvas, announcer } : { hasPointerLock, canvas, announcer },
    );
    const triggerState = (pending: CameraMode | null, state: WalkLoadState) => {
      pendingMode = pending;
      walkLoadState = state;
      readyListeners.forEach((listener) => listener());
    };
    const triggerWalkReady = () => {
      walkLoadState = 'ready';
      for (const l of readyListeners) {
        l();
      }
    };
    return { mount, handle, triggerWalkReady, triggerState };
  }

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
      const guidance = hint.textContent;
      expect(hint.hidden).toBe(false);
      expect(hint.hasAttribute('aria-live')).toBe(false);
      expect(say.mock.calls.filter(([text]) => text === guidance)).toHaveLength(1);
      await mode.mount.setMode('orbit');
      await mode.mount.setMode('walk');
      expect(say.mock.calls.filter(([text]) => text === guidance)).toHaveLength(2);
    } finally { mode.handle.dispose(); }
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

  it('keeps Orbit selectable after Walk has released the mouse', async () => {
    const { mount, handle } = make('walk', true);
    const orbit = root.querySelector('button[data-mode="orbit"]') as HTMLButtonElement;

    orbit.click();
    expect(mount.setMode).toHaveBeenCalledWith('orbit');

    handle.dispose();
  });

  it('shows clear pointer-lock exit guidance while walking', () => {
    const { mount, handle } = make('walk', true);
    const hint = document.body.querySelector<HTMLElement>('.archviz-walk-hint');

    expect(hint?.hidden).toBe(false);
    expect(hint?.textContent).toContain('Press Esc to release the mouse');
    expect(hint?.textContent).toContain('Press O to return to Orbit');

    void mount.setMode('orbit');
    expect(hint?.hidden).toBe(true);

    handle.dispose();
  });

  it('returns to Orbit with O while walking', () => {
    const { mount, handle } = make('walk', true);
    canvas.focus();
    const event = new KeyboardEvent('keydown', {
      code: 'KeyO',
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(mount.setMode).toHaveBeenCalledWith('orbit');
    handle.dispose();
  });

  it('leaves O alone for modified keys and interactive controls', () => {
    const { mount, handle } = make('walk', true);
    const input = document.createElement('input');
    document.body.appendChild(input);

    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', ctrlKey: true }));

    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'plaintext-only');
    document.body.appendChild(editable);
    editable.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true }));

    expect(mount.setMode).not.toHaveBeenCalled();
    input.remove();
    editable.remove();
    handle.dispose();
  });

  it('keeps pointer-lock guidance and its shortcut off touch Walk controls', () => {
    const { mount, handle } = make('walk', true, false);
    const hint = document.body.querySelector<HTMLElement>('.archviz-walk-hint');

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO' }));

    expect(hint?.hidden).toBe(true);
    expect(mount.setMode).not.toHaveBeenCalled();
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

  it('defaults to pointer-lock ownership when the option is omitted', () => {
    const { mount, handle } = make('walk', true, undefined);
    const hint = document.body.querySelector<HTMLElement>('.archviz-walk-hint')!;

    expect(hint.hidden).toBe(false);
    canvas.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true, cancelable: true }));

    expect(mount.setMode).toHaveBeenCalledWith('orbit');
    handle.dispose();
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

  it('does not request Walk again while Walk already owns the camera', () => {
    const { mount, handle } = make('walk', true);
    const walk = root.querySelector<HTMLButtonElement>('[data-mode="walk"]')!;

    walk.click();

    expect(mount.setMode).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('fires O once per press burst and rearms it once the switch settles', async () => {
    const { mount, handle } = make('walk');
    vi.mocked(mount.setMode).mockImplementation(async () => {});
    canvas.focus();
    const press = () => window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyO', bubbles: true, cancelable: true,
    }));

    press();
    press();
    expect(mount.setMode).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => { setTimeout(resolve, 0); });
    press();
    expect(mount.setMode).toHaveBeenCalledTimes(2);
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

  describe('shortcut accessibility contract', () => {
    it.each([
      ['body', false, false],
      ['guide', false, false],
      ['canvas', false, true],
      ['body', true, true],
      ['guide', true, true],
      ['canvas', true, true],
      ['input', false, false],
      ['input', true, false],
      ['textarea', false, false],
      ['textarea', true, false],
      ['select', false, false],
      ['select', true, false],
      ['button', false, false],
      ['button', true, false],
      ['a', false, false],
      ['a', true, false],
      ['editable', false, false],
      ['editable', true, false],
      ['foreign canvas', false, false],
      ['foreign canvas', true, false],
    ] as const)('scopes O from %s with pointer lock %s to scene ownership %s', (source, locked, allowed) => {
      const { mount, handle } = make('walk');
      const target = source === 'canvas' ? canvas : source === 'body' ? document.body :
        document.createElement(source === 'guide' || source === 'editable' ? 'div' :
          source === 'foreign canvas' ? 'canvas' : source);
      if (target !== canvas && target !== document.body) root.appendChild(target);
      if (source === 'editable') target.setAttribute('contenteditable', 'plaintext-only');
      target.tabIndex = 0;
      target.focus();
      vi.spyOn(document, 'pointerLockElement', 'get').mockReturnValue(
        locked ? source === 'foreign canvas' ? target : canvas : null,
      );
      const event = new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(allowed);
      if (allowed) expect(mount.setMode).toHaveBeenCalledExactlyOnceWith('orbit');
      else expect(mount.setMode).not.toHaveBeenCalled();
      handle.dispose();
    });

    it.each([false, true].flatMap((locked) =>
      (['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'repeat'] as const).map((modifier) =>
        [modifier, locked] as const),
    ))('leaves %s O alone with pointer lock %s', (modifier, locked) => {
        const { mount, handle } = make('walk');
        canvas.focus();
        vi.spyOn(document, 'pointerLockElement', 'get').mockReturnValue(locked ? canvas : null);
        const event = new KeyboardEvent('keydown', {
          code: 'KeyO', bubbles: true, cancelable: true, [modifier]: true,
        });
        canvas.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(mount.setMode).not.toHaveBeenCalled();
        handle.dispose();
    });
  });
});
