import { PerspectiveCamera } from 'three/webgpu';
import { afterEach, beforeEach, vi } from 'vitest';

import { readyWalkLoader } from './camera-walk-fixtures';
import { mountCamera } from '../../src/camera/mount';
import type { CameraMount } from '../../src/camera/mount';

// The camera-mount harness shared by the camera-mount suites: a fresh canvas per test and the
// one live mount, disposed after it. The hooks register when this module loads, so every suite
// that imports the harness runs them, and Vitest's per-file isolation gives each suite its own
// canvas and mount slot.

/** Typed rather than asserted: the mount's option shape is what these coordinates have to fit. */
export const PROOF_VIEW: { position: [number, number, number]; target: [number, number, number] } = {
  position: [0, 1.7, 4.2],
  target: [0, 1, 0],
};

export let canvas: HTMLCanvasElement;
let mount: CameraMount | null = null;

/** The showroom fake keeps lookYaw in step with setLookYaw, the way the real one does. */
function makeFakes() {
  let lookYaw = 0;
  const showroom = {
    setLookYaw: vi.fn((radians: number): void => {
      lookYaw = radians;
    }),
    get lookYaw(): number {
      return lookYaw;
    },
  };
  const loop = {
    invalidate: vi.fn<() => void>(),
    setAnimating: vi.fn<(on: boolean) => void>(),
  };
  return { showroom, loop };
}

beforeEach(() => {
  canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
});

afterEach(() => {
  mount?.dispose();
  mount = null;
  canvas.remove();
});

export function make(opts?: Partial<Parameters<typeof mountCamera>[0]>) {
  const { showroom, loop } = makeFakes();
  const camera = new PerspectiveCamera(40, 1, 0.1, 100);
  mount = mountCamera({
    camera,
    canvas,
    showroom,
    loop,
    proofView: PROOF_VIEW,
    views: { proof: { ...PROOF_VIEW, fov: 40 } },
    isTouch: false,
    collisionUrl: '/content/collision.glb',
    createWalkLoader: readyWalkLoader,
    search: '',
    ...opts,
  });
  return { showroom, loop, camera, mount };
}

export function countAnimating(
  loop: { setAnimating: { mock: { calls: [on: boolean][] } } },
  on: boolean,
): number {
  return loop.setAnimating.mock.calls.filter(([called]) => called === on).length;
}

/** One mouse pointer event on the canvas, the way a drag reaches the orbit through the mount. */
export function pointer(type: string, x: number, y: number): void {
  canvas.dispatchEvent(
    new PointerEvent(type, {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    }),
  );
}
