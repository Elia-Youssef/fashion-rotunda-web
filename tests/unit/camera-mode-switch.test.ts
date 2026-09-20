// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountModeSwitch } from '../../src/camera/mode-switch';
import type { ModeSwitchMount } from '../../src/camera/mode-switch';
import type { CameraMode } from '../../src/camera/mount';

describe('mountModeSwitch', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  function make(initialMode: CameraMode = 'orbit', walkReady = true) {
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

    const handle = mountModeSwitch(root, mount);
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

  it('clicking a button calls setMode', async () => {
    const { mount, handle } = make('orbit', true);
    const walk = root.querySelector('button[data-mode="walk"]') as HTMLButtonElement;

    walk.click();
    expect(mount.setMode).toHaveBeenCalledWith('walk');

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
});
