// @vitest-environment jsdom
import { PerspectiveCamera } from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountCamera } from '../../src/camera/mount';
import type { CameraMount } from '../../src/camera/mount';

/** Typed rather than asserted: the mount's option shape is what these coordinates have to fit. */
const PROOF_VIEW: { position: [number, number, number]; target: [number, number, number] } = {
  position: [0, 1.7, 4.2],
  target: [0, 1, 0],
};
const DEG = Math.PI / 180;

let canvas: HTMLCanvasElement;
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

function make() {
  const { showroom, loop } = makeFakes();
  const camera = new PerspectiveCamera(40, 1, 0.1, 100);
  mount = mountCamera({ camera, canvas, showroom, loop, proofView: PROOF_VIEW });
  return { showroom, loop, camera, mount };
}

function countAnimating(
  loop: { setAnimating: { mock: { calls: [on: boolean][] } } },
  on: boolean,
): number {
  return loop.setAnimating.mock.calls.filter(([called]) => called === on).length;
}

/** One mouse pointer event on the canvas, the way a drag reaches the orbit through the mount. */
function pointer(type: string, x: number, y: number): void {
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

describe('mountCamera', () => {
  it('starts the orbit at the proof view', () => {
    const { camera } = make();
    expect(camera.position.x).toBeCloseTo(0, 9);
    expect(camera.position.y).toBeCloseTo(1.7, 9);
    expect(camera.position.z).toBeCloseTo(4.2, 9);
  });

  it('sets touch-action none and a tab stop on the canvas, and restores both on dispose', () => {
    const { mount: current } = make();
    expect(canvas.style.touchAction).toBe('none');
    expect(canvas.tabIndex).toBe(0);
    current.dispose();
    expect(canvas.style.touchAction).toBe('');
    // The attribute is gone, not set to -1: a canvas that had no tabindex must end with none.
    expect(canvas.hasAttribute('tabindex')).toBe(false);
  });

  it('restores a tabindex the canvas already carried', () => {
    canvas.setAttribute('tabindex', '3');
    const { mount: current } = make();
    expect(canvas.tabIndex).toBe(0);
    current.dispose();
    expect(canvas.getAttribute('tabindex')).toBe('3');
  });

  it('reports moving while the turntable runs and while the orbit glides', () => {
    const { mount: current } = make();
    expect(current.moving).toBe(false);
    current.turntable.start();
    expect(current.moving).toBe(true);
    current.turntable.stop();
    expect(current.moving).toBe(false);
    // main.ts's wake window reads this before it switches the loop off, so a glide has to show.
    pointer('pointerdown', 100, 100);
    pointer('pointermove', 240, 100);
    expect(current.moving).toBe(true);
    pointer('pointerup', 240, 100);
    let guard = 0;
    do {
      current.update(16.7);
      guard += 1;
    } while (current.moving && guard < 500);
    expect(current.moving).toBe(false);
  });

  it('keeps the loop animating while the turntable runs and turns the look', () => {
    const { showroom, loop, mount: current } = make();
    current.turntable.start();
    // At least once, not exactly once: hold re-asserts the flag on every frame of motion because
    // main.ts's wake window writes the same flag and the loop takes the last writer.
    expect(countAnimating(loop, true)).toBeGreaterThanOrEqual(1);
    for (let frame = 0; frame < 30; frame += 1) {
      current.update(16.7);
    }
    const calls = showroom.setLookYaw.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const lastYaw = calls[calls.length - 1][0];
    expect(lastYaw).toBeCloseTo(20 * DEG * ((30 * 16.7) / 1000), 9);
    expect(canvas.dataset.yaw).toBe(lastYaw.toFixed(3));
    expect(countAnimating(loop, false)).toBe(0);
  });

  it('ends with setAnimating(false) exactly once when both the orbit and the turntable are still', () => {
    const { loop, mount: current } = make();
    current.turntable.start();
    current.update(16.7);
    current.turntable.stop();
    current.update(16.7);
    current.update(16.7);
    current.update(16.7);
    expect(countAnimating(loop, false)).toBe(1);
  });

  it('re-asserts animation on every frame the turntable runs, and never after it stops', () => {
    const { loop, mount: current } = make();
    current.turntable.start();
    const started = countAnimating(loop, true);
    // main.ts's wake window would have written false between any two of these frames; each one
    // writes true again, which is what makes the turntable survive the window without a timer.
    current.update(16.7);
    current.update(16.7);
    expect(countAnimating(loop, true)).toBeGreaterThan(started);
    current.turntable.stop();
    const stopped = countAnimating(loop, true);
    current.update(16.7);
    current.update(16.7);
    expect(countAnimating(loop, true)).toBe(stopped);
    expect(countAnimating(loop, false)).toBe(1);
  });

  it('setYaw while stopped turns the look back and asks for one frame', () => {
    const { showroom, loop, mount: current } = make();
    current.turntable.start();
    current.update(1000);
    current.turntable.stop();
    showroom.setLookYaw.mockClear();
    loop.invalidate.mockClear();
    current.turntable.setYaw(0);
    expect(showroom.setLookYaw).toHaveBeenCalledWith(0);
    expect(canvas.dataset.yaw).toBe('0.000');
    expect(loop.invalidate).toHaveBeenCalledTimes(1);
  });

  it('a giant dt advances one bounded step, not the whole idle gap it spans', () => {
    const { showroom, mount: current } = make();
    current.turntable.start();
    // The loop's first frame after an idle page carries the idle gap as dt; the look must not
    // teleport by it.
    current.update(8000);
    const calls = showroom.setLookYaw.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[calls.length - 1][0]).toBeCloseTo(20 * DEG * 0.1, 9);
  });

  it('a drag through the canvas keeps the loop animating until the glide settles', () => {
    const { loop, mount: current } = make();
    pointer('pointerdown', 100, 100);
    pointer('pointermove', 240, 100);
    expect(countAnimating(loop, true)).toBeGreaterThanOrEqual(1);
    pointer('pointerup', 240, 100);
    // One update runs whatever the release decided, so the settle is asserted either way: the
    // orbit reads the wall clock here and a release the guard judges stale carries no glide.
    let guard = 0;
    do {
      current.update(16.7);
      guard += 1;
    } while (current.orbit.moving && guard < 500);
    expect(current.orbit.moving).toBe(false);
    expect(countAnimating(loop, false)).toBe(1);
  });

  it('exposes window.archvizCamera in the dev build and removes it on dispose', () => {
    const { mount: current } = make();
    expect(window.archvizCamera?.orbit).toBe(current.orbit);
    expect(window.archvizCamera?.turntable).toBe(current.turntable);
    current.dispose();
    expect(window.archvizCamera).toBeUndefined();
    expect(canvas.dataset.yaw).toBeUndefined();
  });
});
