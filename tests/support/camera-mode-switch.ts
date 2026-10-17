import { afterEach, beforeEach, vi } from 'vitest';

import { mountAnnouncer } from '../../src/ui/announce';
import type { Announcer } from '../../src/ui/announce';
import { mountModeSwitch } from '../../src/camera/mode-switch';
import type { ModeSwitchMount } from '../../src/camera/mode-switch';
import type { WalkLoadState } from '../../src/camera/contracts';
import type { CameraMode } from '../../src/camera/mount';

// The mountModeSwitch harness shared by the camera-mode-switch suites: a fresh root, announcer
// and canvas per test. The hooks register when this module loads, so every suite that imports
// the harness runs them, and Vitest's per-file isolation gives each suite its own DOM.

export let root: HTMLElement;
export let announcer: Announcer;
export let canvas: HTMLCanvasElement;

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

export function make(
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
