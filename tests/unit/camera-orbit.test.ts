// @vitest-environment jsdom
import { PerspectiveCamera, Spherical, Vector3 } from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createOrbit } from '../../src/camera/orbit';
import type { OrbitHandle, OrbitLimits } from '../../src/camera/orbit';

const TARGET: [number, number, number] = [0, 1, 0];
const PROOF_POSITION: [number, number, number] = [0, 1.7, 4.2];
const LIMITS: OrbitLimits = {
  minDistance: 1.2,
  maxDistance: 7,
  minPolar: 0.15,
  maxPolar: Math.PI / 2 - 0.05,
};
const PROOF_RADIUS = Math.hypot(0.7, 4.2);
const PROOF_POLAR = Math.acos(0.7 / PROOF_RADIUS);
/** 1 - damping for the mount's 0.12; the tests drain the glide by hand and need the same number. */
const DECAY_BASE = 0.88;

const onChange = vi.fn();
let mounted: { element: HTMLElement; orbit: OrbitHandle }[] = [];

beforeEach(() => {
  onChange.mockReset();
  mounted = [];
});

afterEach(() => {
  while (mounted.length > 0) {
    const current = mounted.pop();
    if (current === undefined) {
      continue;
    }
    current.orbit.dispose();
    current.element.remove();
  }
});

/**
 * Each orbit gets its own element, so gestures meant for one never reach another. Pass a clock to
 * drive the stale-release guard by hand; without one the orbit reads performance.now, which the
 * tests that do not care about the release window leave in place.
 */
function make(clock?: { ms: number }): { element: HTMLElement; orbit: OrbitHandle } {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const camera = new PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(...PROOF_POSITION);
  camera.lookAt(...TARGET);
  const orbit = createOrbit({
    camera,
    element,
    target: TARGET,
    limits: LIMITS,
    damping: 0.12,
    onChange,
    ...(clock === undefined ? {} : { now: (): number => clock.ms }),
  });
  mounted.push({ element, orbit });
  return { element, orbit };
}

/** The camera's spherical state around the target, recomputed from the position it renders from. */
function readSpherical(orbit: OrbitHandle): Spherical {
  return new Spherical().setFromVector3(new Vector3(...orbit.position).sub(new Vector3(...TARGET)));
}

function pointer(target: { element: HTMLElement }, type: string, x: number, y: number, pointerId = 1): void {
  target.element.dispatchEvent(
    new PointerEvent(type, {
      pointerId,
      pointerType: 'mouse',
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function wheel(target: { element: HTMLElement }, deltaY: number, ctrlKey = false): void {
  target.element.dispatchEvent(
    new WheelEvent('wheel', { deltaY, ctrlKey, bubbles: true, cancelable: true }),
  );
}

function key(target: { element: HTMLElement }, keyboardKey: string): void {
  target.element.dispatchEvent(new KeyboardEvent('keydown', { key: keyboardKey, bubbles: true }));
}

/** A one-move drag: down, the move, up. The move's delta is what the glide then carries. */
function drag(target: { element: HTMLElement }, dx: number, dy: number): void {
  pointer(target, 'pointerdown', 100, 100);
  pointer(target, 'pointermove', 100 + dx, 100 + dy);
  pointer(target, 'pointerup', 100 + dx, 100 + dy);
}

describe('createOrbit', () => {
  it('starts at the camera pose it was given', () => {
    const { orbit } = make();
    const state = readSpherical(orbit);
    expect(state.radius).toBeCloseTo(PROOF_RADIUS, 9);
    expect(state.theta).toBeCloseTo(0, 9);
    expect(state.phi).toBeCloseTo(PROOF_POLAR, 9);
  });

  it('rotates yaw by 0.005 radians per pixel of horizontal drag', () => {
    const target = make();
    pointer(target, 'pointerdown', 100, 100);
    pointer(target, 'pointermove', 200, 100);
    expect(readSpherical(target.orbit).theta).toBeCloseTo(-100 * 0.005, 9);
  });

  it('changes polar by the same scale under a vertical drag', () => {
    const target = make();
    pointer(target, 'pointerdown', 100, 100);
    pointer(target, 'pointermove', 100, 180);
    expect(readSpherical(target.orbit).phi).toBeCloseTo(PROOF_POLAR - 80 * 0.005, 9);
  });

  it('clamps polar when a drag lifts the camera past the zenith limit', () => {
    const target = make();
    pointer(target, 'pointerdown', 100, 100);
    pointer(target, 'pointermove', 100, 100100);
    expect(readSpherical(target.orbit).phi).toBeCloseTo(LIMITS.minPolar, 9);
  });

  it('clamps polar when a drag drops the camera below the horizon limit', () => {
    const target = make();
    pointer(target, 'pointerdown', 100, 100);
    pointer(target, 'pointermove', 100, -100100);
    expect(readSpherical(target.orbit).phi).toBeCloseTo(LIMITS.maxPolar, 9);
  });

  it('clamps the distance at both ends however far the wheel runs', () => {
    const target = make();
    for (let notch = 0; notch < 100; notch += 1) {
      wheel(target, 1000);
    }
    expect(readSpherical(target.orbit).radius).toBeCloseTo(LIMITS.maxDistance, 9);
    for (let notch = 0; notch < 200; notch += 1) {
      wheel(target, -1000);
    }
    expect(readSpherical(target.orbit).radius).toBeCloseTo(LIMITS.minDistance, 9);
  });

  it('dollies one wheel notch by the stated factor: out on scroll down, in on scroll up', () => {
    const target = make();
    wheel(target, 100);
    expect(readSpherical(target.orbit).radius).toBeCloseTo(PROOF_RADIUS * 1.1, 9);
    wheel(target, -100);
    expect(readSpherical(target.orbit).radius).toBeCloseTo(PROOF_RADIUS, 9);
  });

  it('applies a held drag once however many frames drain during it', () => {
    // The glide belongs to the release. Draining it while the pointer is still down applied every
    // move a second time, at a scale set by how many moves the device delivers per frame: these
    // ten 10 px moves with one frame each landed at about -0.9694 instead of the drag's -0.5.
    const target = make();
    pointer(target, 'pointerdown', 100, 100);
    for (let step = 1; step <= 10; step += 1) {
      pointer(target, 'pointermove', 100 + step * 10, 100);
      target.orbit.update(16.7);
    }
    expect(readSpherical(target.orbit).theta).toBeCloseTo(-100 * 0.005, 9);
  });

  it('reports motion while the pointer is down, so the loop keeps drawing the drag', () => {
    const target = make();
    pointer(target, 'pointerdown', 100, 100);
    expect(target.orbit.update(16.7)).toBe(true);
  });

  it('does not glide when the hand held still before it let go', () => {
    const clock = { ms: 1000 };
    const target = make(clock);
    pointer(target, 'pointerdown', 100, 100);
    pointer(target, 'pointermove', 140, 100);
    const held = readSpherical(target.orbit).theta;
    // 200 ms of stillness, past the 80 ms window: the armed delta is a move that is already over.
    clock.ms += 200;
    pointer(target, 'pointerup', 140, 100);
    expect(target.orbit.moving).toBe(false);
    for (let frame = 0; frame < 20; frame += 1) {
      expect(target.orbit.update(16.7)).toBe(false);
    }
    expect(readSpherical(target.orbit).theta).toBeCloseTo(held, 12);
  });

  it('glides when the release follows the last move inside the window', () => {
    const clock = { ms: 1000 };
    const target = make(clock);
    pointer(target, 'pointerdown', 100, 100);
    pointer(target, 'pointermove', 140, 100);
    const released = readSpherical(target.orbit).theta;
    clock.ms += 16;
    pointer(target, 'pointerup', 140, 100);
    expect(target.orbit.moving).toBe(true);
    expect(target.orbit.update(16.7)).toBe(true);
    // The drag ran theta negative; the glide carries it further the same way.
    expect(readSpherical(target.orbit).theta).toBeLessThan(released);
  });

  it('ignores a ctrl+wheel pinch, which the browser answers by zooming the page', () => {
    const target = make();
    const before = readSpherical(target.orbit).radius;
    wheel(target, 100, true);
    expect(readSpherical(target.orbit).radius).toBeCloseTo(before, 12);
    wheel(target, -100, true);
    expect(readSpherical(target.orbit).radius).toBeCloseTo(before, 12);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('dollies by the change in finger spread on a two-finger pinch', () => {
    const target = make();
    pointer(target, 'pointerdown', 100, 100, 1);
    pointer(target, 'pointerdown', 300, 100, 2);
    pointer(target, 'pointermove', 250, 100, 2);
    // Fingers that came together by a quarter dollies out by 200/150.
    expect(readSpherical(target.orbit).radius).toBeCloseTo((PROOF_RADIUS * 200) / 150, 9);
    pointer(target, 'pointerup', 250, 100, 2);
    // The surviving finger rotates again, anchored where it actually is.
    pointer(target, 'pointermove', 150, 100, 1);
    expect(readSpherical(target.orbit).theta).toBeCloseTo(-50 * 0.005, 9);
  });

  it('the arrow keys rotate, + and - dolly, and Home resets', () => {
    const target = make();
    key(target, 'ArrowLeft');
    expect(readSpherical(target.orbit).theta).toBeCloseTo(Math.PI / 60, 9);
    key(target, 'ArrowRight');
    expect(readSpherical(target.orbit).theta).toBeCloseTo(0, 9);
    key(target, 'ArrowUp');
    expect(readSpherical(target.orbit).phi).toBeCloseTo(PROOF_POLAR - Math.PI / 60, 9);
    key(target, 'ArrowDown');
    expect(readSpherical(target.orbit).phi).toBeCloseTo(PROOF_POLAR, 9);
    key(target, '+');
    expect(readSpherical(target.orbit).radius).toBeCloseTo(PROOF_RADIUS / 1.1, 9);
    key(target, '-');
    expect(readSpherical(target.orbit).radius).toBeCloseTo(PROOF_RADIUS, 9);
    key(target, 'ArrowLeft');
    key(target, 'Home');
    expect(readSpherical(target.orbit).theta).toBeCloseTo(0, 9);
  });

  it('update drains the glide and returns false once still', () => {
    // A frozen clock releases inside the stale-release window every time, so the glide this test
    // is about is armed by construction rather than by how fast the machine dispatched the events.
    const target = make({ ms: 1000 });
    drag(target, 40, 0);
    expect(target.orbit.moving).toBe(true);
    let moving = true;
    for (let frame = 0; frame < 200 && moving; frame += 1) {
      moving = target.orbit.update(16.7);
    }
    expect(moving).toBe(false);
    expect(target.orbit.moving).toBe(false);
  });

  it('the glide settles on the same pose whatever frame grid drains it', () => {
    // Two orbits with the same released drag, drained by update sequences whose dt sums match:
    // 60 frames of 16.7 ms against 30 of 33.4 ms. The naive per-frame fraction of the remaining
    // motion misses by degrees here; only the exact integral of the decay lands both on one pose.
    // Both stop the moment the remaining motion drops under 1e-4, which is the same a^60 tail
    // either way, so the closed form below is the exact landing point of both sequences.
    const slow = make({ ms: 1000 });
    drag(slow, 40, 0);
    const fast = make({ ms: 1000 });
    drag(fast, 40, 0);
    for (let frame = 0; frame < 60; frame += 1) {
      slow.orbit.update(16.7);
    }
    for (let frame = 0; frame < 30; frame += 1) {
      fast.orbit.update(33.4);
    }
    const glide = (1 - Math.pow(DECAY_BASE, 60)) / -Math.log(DECAY_BASE);
    const expected = -40 * 0.005 - 40 * 0.005 * glide;
    const slowState = readSpherical(slow.orbit);
    const fastState = readSpherical(fast.orbit);
    expect(slowState.theta).toBeCloseTo(expected, 6);
    expect(fastState.theta).toBeCloseTo(expected, 6);
    expect(Math.abs(slowState.theta - fastState.theta)).toBeLessThan(1e-3);
    expect(Math.abs(slowState.phi - fastState.phi)).toBeLessThan(1e-3);
  });

  it('setPose moves the camera and becomes what reset returns to', () => {
    const target = make();
    const pose: [number, number, number] = [2, 1.6, 3];
    target.orbit.setPose(pose, TARGET);
    const placed = target.orbit.position;
    expect(placed[0]).toBeCloseTo(2, 9);
    expect(placed[1]).toBeCloseTo(1.6, 9);
    expect(placed[2]).toBeCloseTo(3, 9);
    drag(target, -200, 300);
    wheel(target, 500);
    target.orbit.update(16.7);
    target.orbit.reset();
    const back = target.orbit.position;
    expect(back[0]).toBeCloseTo(2, 9);
    expect(back[1]).toBeCloseTo(1.6, 9);
    expect(back[2]).toBeCloseTo(3, 9);
    expect(target.orbit.moving).toBe(false);
  });

  it('asks for a frame on every applied change', () => {
    const target = make();
    pointer(target, 'pointerdown', 100, 100);
    pointer(target, 'pointermove', 150, 100);
    wheel(target, 100);
    key(target, 'ArrowLeft');
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('dispose removes every listener: a drag after it changes nothing', () => {
    const target = make();
    target.orbit.dispose();
    onChange.mockClear();
    const before = target.orbit.position;
    pointer(target, 'pointerdown', 100, 100);
    pointer(target, 'pointermove', 400, 300);
    pointer(target, 'pointerup', 400, 300);
    wheel(target, 1000);
    key(target, 'ArrowLeft');
    expect(target.orbit.position).toEqual(before);
    expect(onChange).not.toHaveBeenCalled();
    expect(target.orbit.moving).toBe(false);
  });
});
