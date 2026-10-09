// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountModeSwitch } from '../../src/camera/mode-switch';
import type { ModeSwitchMount } from '../../src/camera/mode-switch';
import type { CameraMode } from '../../src/camera/mount';

describe('mountModeSwitch', () => {
  let root: HTMLElement;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
    canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    root.appendChild(canvas);
    // jsdom does not implement pointer lock; model the browser-owned getter explicitly.
    Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => null });
  });

  afterEach(() => {
    root.remove();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, 'pointerLockElement');
  });

  function make(
    initialMode: CameraMode = 'orbit',
    walkReady = true,
    hasPointerLock = true,
  ) {
    let mode = initialMode;
    const listeners = new Set<(m: CameraMode) => void>();
    const readyListeners = new Set<() => void>();

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
      walkReady,
      onWalkReady: vi.fn((listener) => {
        readyListeners.add(listener);
        return () => readyListeners.delete(listener);
      }),
    };

    const handle = mountModeSwitch(root, mount, { hasPointerLock, canvas });
    const triggerWalkReady = () => {
      for (const l of readyListeners) {
        l();
      }
    };
    return { mount, handle, triggerWalkReady };
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

  it('shows Loading the floor tooltip and disables Walk button until ready', () => {
    const { handle, triggerWalkReady } = make('orbit', false);
    const walk = root.querySelector('button[data-mode="walk"]') as HTMLButtonElement;

    expect(walk.disabled).toBe(true);
    expect(walk.getAttribute('data-tooltip')).toBe('Loading the floor');

    triggerWalkReady();
    expect(walk.disabled).toBe(false);
    expect(walk.getAttribute('data-tooltip')).toBe('Walk the showroom floor');

    handle.dispose();
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
