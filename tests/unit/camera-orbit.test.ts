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
  vi.unstubAllGlobals();
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
 * tests that do not care about the release window leave in place. Damping and the camera's
 * starting position are overridable for the edge poses the default never produces.
 */
function make(
  clock?: { ms: number },
  damping = 0.12,
  position: [number, number, number] = PROOF_POSITION,
): { element: HTMLElement; orbit: OrbitHandle; camera: PerspectiveCamera } {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const camera = new PerspectiveCamera(40, 1, 0.1, 100);
  camera.position.set(...position);
  camera.lookAt(...TARGET);
  const orbit = createOrbit({
    camera,
    element,
    target: TARGET,
    limits: LIMITS,
    damping,
    onChange,
    ...(clock === undefined ? {} : { now: (): number => clock.ms }),
  });
  mounted.push({ element, orbit });
  return { element, orbit, camera };
}

/** A pointerdown with a chosen button, the way middle and right clicks arrive. */
function buttonDown(target: { element: HTMLElement }, button: number): void {
  target.element.dispatchEvent(
    new PointerEvent('pointerdown', {
      pointerId: 1,
      pointerType: 'mouse',
      button,
      buttons: button,
      clientX: 100,
      clientY: 100,
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** Mounts an element whose pointer capture can be observed through mocks. */
function makeWithCaptureMocks(): { element: HTMLElement; orbit: OrbitHandle; release: ReturnType<typeof vi.fn> } {
  const target = make();
  const release = vi.fn();
  target.element.setPointerCapture = vi.fn();
  target.element.releasePointerCapture = release;
  return { element: target.element, orbit: target.orbit, release };
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

  it('reports the live vertical FOV after a pose change', () => {
    const { orbit } = make();
    expect(orbit.fov).toBe(40);
    orbit.setPose(PROOF_POSITION, TARGET, 55);
    expect(orbit.fov).toBe(55);
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

  it('reports motion while a drag is held, and none after a still release', () => {
    const clock = { ms: 1000 };
    const target = make(clock);
    pointer(target, 'pointerdown', 100, 100);
    pointer(target, 'pointermove', 120, 100);
    // The post chain lowers its heavy effects on this reading, so a held drag must count.
    expect(target.orbit.moving).toBe(true);
    clock.ms += 200;
    pointer(target, 'pointerup', 120, 100);
    expect(target.orbit.moving).toBe(false);
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

  it('reads reduced motion at release and leaves both drag axes still without damping', () => {
    const query = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal('matchMedia', () => query);
    const clock = { ms: 1_000 };
    const target = make(clock);
    pointer(target, 'pointerdown', 100, 100);
    pointer(target, 'pointermove', 140, 130);
    expect(target.orbit.position).not.toEqual(PROOF_POSITION);
    const released = target.orbit.position;
    query.matches = true;
    query.dispatchEvent(Object.assign(new Event('change'), { matches: true }));
    pointer(target, 'pointerup', 140, 130);
    expect(target.orbit.moving).toBe(false);
    for (let frame = 0; frame < 20; frame += 1) {
      expect(target.orbit.update(16.7)).toBe(false);
      expect(target.orbit.position).toEqual(released);
    }

    // The same control resumes its usual release glide after another live preference change.
    pointer(target, 'pointerdown', 100, 100);
    pointer(target, 'pointermove', 120, 110);
    const nextRelease = target.orbit.position;
    query.matches = false;
    query.dispatchEvent(Object.assign(new Event('change'), { matches: false }));
    pointer(target, 'pointerup', 120, 110);
    expect(target.orbit.moving).toBe(true);
    expect(target.orbit.update(16.7)).toBe(true);
    expect(target.orbit.position).not.toEqual(nextRelease);
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

  it('retains pointer records without spreading pinch values and preserves capture and cancellation', () => {
    const target = make({ ms: 1000 });
    const capture = vi.fn();
    const release = vi.fn();
    target.element.setPointerCapture = capture;
    target.element.releasePointerCapture = release;
    const set = vi.spyOn(Map.prototype, 'set');
    pointer(target, 'pointerdown', 100, 100, 1);
    const entry = set.mock.calls.find(([id, value]) =>
      id === 1 && value?.x === 100 && value?.y === 100);
    expect(entry).toBeDefined();
    const index = set.mock.calls.indexOf(entry!);
    const tracked = set.mock.contexts[index] as Map<number, { x: number; y: number }>;
    const first = tracked.get(1)!;
    pointer(target, 'pointerdown', 300, 100, 2);
    const second = tracked.get(2)!;
    const iterate = vi.fn();
    const values = tracked.values.bind(tracked);
    const read = vi.spyOn(tracked, 'values').mockImplementation(() => {
      const iterator = values();
      const original = iterator[Symbol.iterator].bind(iterator);
      iterator[Symbol.iterator] = () => { iterate(); return original(); };
      return iterator;
    });
    pointer(target, 'pointermove', 250, 100, 2);
    expect(tracked.get(2)).toBe(second);
    expect(second).toEqual({ x: 250, y: 100, pan: false });
    expect(readSpherical(target.orbit).radius).toBeCloseTo(PROOF_RADIUS * 200 / 150, 9);
    pointer(target, 'pointerdown', 500, 100, 3);
    pointer(target, 'pointermove', 600, 100, 3);
    expect(readSpherical(target.orbit).radius).toBeCloseTo(PROOF_RADIUS * 200 / 150, 9);
    pointer(target, 'pointercancel', 600, 100, 3);
    pointer(target, 'pointermove', 999, 999, 9);
    expect(tracked.size).toBe(2);
    pointer(target, 'pointercancel', 250, 100, 2);
    expect(release.mock.calls).toEqual([[3]]);
    pointer(target, 'pointermove', 150, 100, 1);
    expect(tracked.get(1)).toBe(first);
    expect(first).toEqual({ x: 150, y: 100, pan: false });
    expect(readSpherical(target.orbit).theta).toBeCloseTo(-0.25, 9);
    expect(iterate).not.toHaveBeenCalled();
    target.orbit.setEnabled(false);
    expect(tracked.size).toBe(0);
    pointer(target, 'pointermove', 200, 100, 1);
    expect(first.x).toBe(150);
    expect(capture.mock.calls).toEqual([[1], [2], [3]]);
    read.mockRestore();
    set.mockRestore();
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

  it('moveTo places the camera and leaves reset on the pose it was built with', () => {
    const target = make();
    const pose: [number, number, number] = [2, 1.6, 3];
    target.orbit.moveTo(pose, TARGET);
    const placed = target.orbit.position;
    expect(placed[0]).toBeCloseTo(2, 9);
    expect(placed[1]).toBeCloseTo(1.6, 9);
    expect(placed[2]).toBeCloseTo(3, 9);
    target.orbit.reset();
    const back = target.orbit.position;
    expect(back[0]).toBeCloseTo(PROOF_POSITION[0], 9);
    expect(back[1]).toBeCloseTo(PROOF_POSITION[1], 9);
    expect(back[2]).toBeCloseTo(PROOF_POSITION[2], 9);
    expect(target.orbit.moving).toBe(false);
  });

  it('moveTo clamps the distance and the polar angle exactly as setPose does', () => {
    const far = make();
    const near = make();
    const outside: [number, number, number] = [0, 40, 40];
    far.orbit.setPose(outside, TARGET);
    near.orbit.moveTo(outside, TARGET);
    expect(readSpherical(near.orbit).radius).toBeCloseTo(readSpherical(far.orbit).radius, 9);
    expect(readSpherical(near.orbit).phi).toBeCloseTo(readSpherical(far.orbit).phi, 9);
    expect(readSpherical(near.orbit).theta).toBeCloseTo(readSpherical(far.orbit).theta, 9);
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

  it('glideTo 0ms lands immediately and resolves', async () => {
    const target = make();
    const destPos: [number, number, number] = [0, 2.0, 3.0];
    const destTarget: [number, number, number] = [0, 1.0, 0];
    await target.orbit.glideTo(destPos, destTarget, 0);

    expect(target.orbit.position[0]).toBeCloseTo(0, 5);
    expect(target.orbit.position[1]).toBeCloseTo(2.0, 5);
    expect(target.orbit.position[2]).toBeCloseTo(3.0, 5);
    expect(target.orbit.moving).toBe(false);
  });

  it('glideTo over duration reports moving, eases, respects limits, and lands exactly', async () => {
    const target = make();
    const destPos: [number, number, number] = [0, 2.0, 3.0];
    const destTarget: [number, number, number] = [0, 1.0, 0];

    let resolved = false;
    const glidePromise = target.orbit.glideTo(destPos, destTarget, 300).then(() => {
      resolved = true;
    });

    expect(target.orbit.moving).toBe(true);
    expect(resolved).toBe(false);

    // Halfway (150 ms): in flight.
    target.orbit.update(150);
    expect(target.orbit.moving).toBe(true);
    expect(resolved).toBe(false);

    // Finish remaining (150 ms): arrives.
    target.orbit.update(150);
    await glidePromise;
    expect(resolved).toBe(true);
    expect(target.orbit.moving).toBe(false);
    expect(target.orbit.position[0]).toBeCloseTo(0, 5);
    expect(target.orbit.position[1]).toBeCloseTo(2.0, 5);
    expect(target.orbit.position[2]).toBeCloseTo(3.0, 5);
  });

  it('interpolates FOV during a glide and lands on the authored value exactly', async () => {
    const target = make();
    const glide = target.orbit.glideTo([0, 2, 3], TARGET, 300, 55);
    target.orbit.update(150);
    expect(target.camera.fov).toBeGreaterThan(40);
    expect(target.camera.fov).toBeLessThan(55);
    target.orbit.update(150);
    await glide;
    expect(target.camera.fov).toBe(55);
  });

  it('cuts FOV immediately when a reduced-motion preset asks for zero duration', async () => {
    const target = make();
    await target.orbit.glideTo([0, 2, 3], TARGET, 0, 35);
    expect(target.camera.fov).toBe(35);
  });

  it('setEnabled(false) ignores input gestures', () => {
    const target = make();
    const before = target.orbit.position;
    target.orbit.setEnabled(false);

    pointer(target, 'pointerdown', 100, 100);
    pointer(target, 'pointermove', 200, 100);
    expect(target.orbit.moving).toBe(false);
    expect(target.orbit.position).toEqual(before);

    target.orbit.setEnabled(true);
    pointer(target, 'pointerdown', 100, 100);
    pointer(target, 'pointermove', 200, 100);
    expect(target.orbit.moving).toBe(true);
  });

  it('keeps gliding when the caller asks for damping of exactly one', () => {
    // damping 1 is the log(0) edge the constructor clamps away; the release glide must
    // still move the camera once and then settle.
    const target = make(undefined, 1);
    drag(target, 40, 0);
    const released = readSpherical(target.orbit).theta;
    expect(target.orbit.moving).toBe(true);
    target.orbit.update(16.7);
    expect(readSpherical(target.orbit).theta).toBeLessThan(released);
    expect(target.orbit.moving).toBe(false);
  });

  it('arms nothing at damping zero: a released drag stops dead and the pose stays finite', () => {
    const target = make(undefined, 0);
    drag(target, 40, 0);
    expect(target.orbit.moving).toBe(false);
    expect(target.orbit.update(16.7)).toBe(false);
    const position = target.orbit.position;
    expect(Number.isFinite(position[0])).toBe(true);
    expect(Number.isFinite(position[1])).toBe(true);
    expect(Number.isFinite(position[2])).toBe(true);
  });

  it('reads the wall clock when no clock is injected: a held-still release does not glide', async () => {
    const target = make();
    pointer(target, 'pointerdown', 100, 100);
    pointer(target, 'pointermove', 140, 100);
    const held = readSpherical(target.orbit).theta;
    // 150 ms of real stillness, past the 80 ms stale-release window.
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    pointer(target, 'pointerup', 140, 100);
    expect(target.orbit.moving).toBe(false);
    expect(readSpherical(target.orbit).theta).toBeCloseTo(held, 12);
  });

  it('reports motion from the drag alone, before any move has armed a glide', () => {
    // The post chain lowers its heavy effects while this reads true, so a grabbed but
    // not yet moved subject must already count as motion.
    const target = make();
    pointer(target, 'pointerdown', 100, 100);
    expect(target.orbit.moving).toBe(true);
  });

  it('arrow keys are discrete steps and never arm the release glide', () => {
    const target = make();
    key(target, 'ArrowLeft');
    expect(readSpherical(target.orbit).theta).toBeCloseTo(Math.PI / 60, 9);
    expect(target.orbit.moving).toBe(false);
    expect(target.orbit.update(16.7)).toBe(false);
    expect(readSpherical(target.orbit).theta).toBeCloseTo(Math.PI / 60, 9);
  });

  it('ignores wheel and keys while disabled, not only pointer gestures', () => {
    const target = make();
    const before = readSpherical(target.orbit);
    target.orbit.setEnabled(false);
    onChange.mockClear();
    wheel(target, 100);
    key(target, 'ArrowLeft');
    key(target, '-');
    expect(readSpherical(target.orbit).radius).toBeCloseTo(before.radius, 12);
    expect(readSpherical(target.orbit).theta).toBeCloseTo(before.theta, 12);
    expect(onChange).not.toHaveBeenCalled();
    expect(target.orbit.moving).toBe(false);
  });

  it('treats the middle mouse button as a non-inspection input', () => {
    const target = make();
    buttonDown(target, 1);
    expect(target.orbit.moving).toBe(false);
    pointer(target, 'pointermove', 300, 100);
    expect(readSpherical(target.orbit).theta).toBeCloseTo(0, 9);
  });

  it('a move with no delta neither rotates nor refreshes the release window', () => {
    const clock = { ms: 1000 };
    const target = make(clock);
    pointer(target, 'pointerdown', 100, 100);
    pointer(target, 'pointermove', 140, 100);
    expect(onChange).toHaveBeenCalledTimes(1);
    clock.ms += 200;
    pointer(target, 'pointermove', 140, 100);
    expect(onChange).toHaveBeenCalledTimes(1);
    pointer(target, 'pointerup', 140, 100);
    expect(target.orbit.moving).toBe(false);
  });

  it('a pointer the control never grabbed cannot end a released glide', () => {
    const clock = { ms: 1000 };
    const target = make(clock);
    drag(target, 40, 0);
    expect(target.orbit.moving).toBe(true);
    clock.ms += 200;
    pointer(target, 'pointerup', 140, 100, 99);
    expect(target.orbit.moving).toBe(true);
    expect(target.orbit.update(16.7)).toBe(true);
  });

  it('after a pinch the surviving finger rotates from where it actually is', () => {
    const target = make();
    pointer(target, 'pointerdown', 100, 100, 1);
    pointer(target, 'pointerdown', 300, 100, 2);
    pointer(target, 'pointermove', 200, 100, 1);
    pointer(target, 'pointerup', 300, 100, 2);
    pointer(target, 'pointermove', 250, 100, 1);
    expect(readSpherical(target.orbit).theta).toBeCloseTo(-50 * 0.005, 9);
  });

  it('a pinch whose fingers meet exactly changes nothing', () => {
    const target = make();
    pointer(target, 'pointerdown', 100, 100, 1);
    pointer(target, 'pointerdown', 200, 100, 2);
    pointer(target, 'pointermove', 100, 100, 2);
    pointer(target, 'pointermove', 150, 100, 2);
    expect(readSpherical(target.orbit).radius).toBeCloseTo(PROOF_RADIUS, 9);
  });

  it('scales Firefox line-mode and page-mode wheels back to pixel notches', () => {
    const target = make();
    target.element.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, bubbles: true, cancelable: true }),
    );
    expect(readSpherical(target.orbit).radius).toBeCloseTo(PROOF_RADIUS * Math.pow(1.1, 0.99), 9);
    target.element.dispatchEvent(
      new WheelEvent('wheel', { deltaY: 1, deltaMode: 2, bubbles: true, cancelable: true }),
    );
    expect(readSpherical(target.orbit).radius).toBeCloseTo(PROOF_RADIUS * Math.pow(1.1, 0.99) * 1.1, 9);
  });

  it("treats '=' as '+' for the dolly-in key", () => {
    const target = make();
    key(target, '=');
    expect(readSpherical(target.orbit).radius).toBeCloseTo(PROOF_RADIUS / 1.1, 9);
  });

  it('reset lands inside the limits even when the built-in pose was authored outside them', () => {
    const low = make(undefined, 0.12, [0, -5, 3]);
    low.orbit.reset();
    expect(readSpherical(low.orbit).phi).toBeCloseTo(LIMITS.maxPolar, 9);
    const far = make(undefined, 0.12, [0, 1.7, 70]);
    far.orbit.reset();
    expect(readSpherical(far.orbit).radius).toBeCloseTo(LIMITS.maxDistance, 9);
  });

  it('a single over-long update lands exactly on the glide destination', async () => {
    const target = make();
    const glide = target.orbit.glideTo([0, 2, 3], TARGET, 300);
    target.orbit.update(400);
    await glide;
    expect(target.orbit.position[0]).toBeCloseTo(0, 9);
    expect(target.orbit.position[1]).toBeCloseTo(2, 9);
    expect(target.orbit.position[2]).toBeCloseTo(3, 9);
    expect(target.orbit.moving).toBe(false);
  });

  it('a glide between opposite sides of the target never leaves the limits', () => {
    // The straight Cartesian chord between the two sides passes through the target, so
    // the interpolated pose dips under both the polar and the distance floor mid-glide.
    const target = make(undefined, 0.12, [4, 1.5, 0]);
    void target.orbit.glideTo([-4, 1.5, 0], TARGET, 1000);
    target.orbit.update(500);
    const state = readSpherical(target.orbit);
    expect(state.phi).toBeCloseTo(LIMITS.minPolar, 5);
    expect(state.radius).toBeCloseTo(LIMITS.minDistance, 5);
  });

  it('a glide toward a below-horizon destination eases toward the polar limit, not pinned at it', () => {
    const target = make();
    target.orbit.setPose([0, 4, 4.2], TARGET);
    void target.orbit.glideTo([0, -5, 3], TARGET, 1000);
    target.orbit.update(500);
    expect(readSpherical(target.orbit).phi).toBeLessThan(LIMITS.maxPolar - 0.05);
  });

  it('a glide toward a too-far destination eases toward the distance limit, not pinned at it', () => {
    const target = make();
    void target.orbit.glideTo([0, 1.7, 40], TARGET, 1000);
    target.orbit.update(500);
    expect(readSpherical(target.orbit).radius).toBeLessThan(LIMITS.maxDistance - 0.05);
  });

  it('update with a zero frame integrates nothing and asks for no frame', () => {
    const gliding = make();
    void gliding.orbit.glideTo([0, 2, 3], TARGET, 300);
    onChange.mockClear();
    gliding.orbit.update(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(gliding.orbit.moving).toBe(true);

    const clock = { ms: 1000 };
    const armed = make(clock);
    drag(armed, 40, 0);
    onChange.mockClear();
    armed.orbit.update(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(readSpherical(armed.orbit).theta).toBeCloseTo(-40 * 0.005, 9);
  });

  it('grabbing the subject resolves a glide in flight instead of leaving it pending', async () => {
    const target = make();
    let resolved = false;
    const glide = target.orbit.glideTo([0, 2, 3], TARGET, 300).then(() => {
      resolved = true;
    });
    pointer(target, 'pointerdown', 100, 100);
    await glide;
    expect(resolved).toBe(true);
    expect(target.orbit.position[1]).toBeLessThan(2);
  });

  it('setPose finishes a glide in flight and keeps the pose it was given', async () => {
    const target = make();
    const glide = target.orbit.glideTo([0, 2, 3], TARGET, 300);
    target.orbit.setPose([2, 1.6, 3], TARGET);
    await glide;
    expect(target.orbit.moving).toBe(false);
    target.orbit.update(150);
    expect(target.orbit.position[0]).toBeCloseTo(2, 9);
    expect(target.orbit.position[1]).toBeCloseTo(1.6, 9);
    expect(target.orbit.position[2]).toBeCloseTo(3, 9);
  });

  it('placeAt finishes a glide in flight and keeps the pose it was given', async () => {
    const target = make();
    const glide = target.orbit.glideTo([0, 2, 3], TARGET, 300);
    target.orbit.placeAt([2, 1.6, 3], TARGET);
    await glide;
    expect(target.orbit.moving).toBe(false);
    target.orbit.update(300);
    expect(target.orbit.position[0]).toBeCloseTo(2, 9);
    expect(target.orbit.position[1]).toBeCloseTo(1.6, 9);
  });

  it('placeAt clamps the live fov when the pose gives none', () => {
    const target = make();
    target.camera.fov = 400;
    target.orbit.placeAt([2, 1.6, 3], TARGET);
    expect(target.orbit.fov).toBe(179);
  });

  it('a glide toward an extreme fov eases toward the clamped value', async () => {
    const target = make();
    const glide = target.orbit.glideTo([0, 2, 3], TARGET, 300, 250);
    target.orbit.update(150);
    expect(target.camera.fov).toBeCloseTo((40 + 179) / 2, 1);
    target.orbit.update(150);
    await glide;
    expect(target.camera.fov).toBe(179);
  });

  it('a zero-ms glide cancels an armed release glide', async () => {
    const clock = { ms: 1000 };
    const target = make(clock);
    drag(target, 40, 0);
    expect(target.orbit.moving).toBe(true);
    await target.orbit.glideTo([0, 2, 3], TARGET, 0);
    expect(target.orbit.moving).toBe(false);
    expect(target.orbit.update(16.7)).toBe(false);
  });

  it('a timed glide cancels an armed release glide and leaves nothing behind after it lands', async () => {
    const clock = { ms: 1000 };
    const target = make(clock);
    drag(target, 40, 0);
    const glide = target.orbit.glideTo([0, 2, 3], TARGET, 50);
    target.orbit.update(50);
    await glide;
    expect(target.orbit.moving).toBe(false);
    expect(target.orbit.update(16.7)).toBe(false);
  });

  it('glideTo asks the loop for the frame that will animate it', () => {
    const target = make();
    onChange.mockClear();
    void target.orbit.glideTo([0, 2, 3], TARGET, 300);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('moveTo carries the fov through to the pose it places', () => {
    const target = make();
    target.orbit.moveTo([2, 1.6, 3], TARGET, 50);
    expect(target.orbit.fov).toBe(50);
  });

  it('enabling input does not cancel motion already in flight', async () => {
    const target = make();
    const glide = target.orbit.glideTo([0, 2, 3], TARGET, 300);
    target.orbit.setEnabled(true);
    expect(target.orbit.moving).toBe(true);
    target.orbit.update(150);
    target.orbit.update(150);
    await glide;
    expect(target.orbit.position[1]).toBeCloseTo(2, 9);
  });

  it('disabling mid-gesture releases the captured pointer', () => {
    const target = makeWithCaptureMocks();
    pointer(target, 'pointerdown', 100, 100);
    target.orbit.setEnabled(false);
    expect(target.release).toHaveBeenCalledWith(1);
  });

  it('disabling stops a held drag and a glide in flight, without leaving motion reported', async () => {
    const clock = { ms: 1000 };
    const held = make(clock);
    pointer(held, 'pointerdown', 100, 100);
    pointer(held, 'pointermove', 140, 100);
    held.orbit.setEnabled(false);
    expect(held.orbit.moving).toBe(false);
    expect(held.orbit.update(16.7)).toBe(false);

    const gliding = make();
    const glide = gliding.orbit.glideTo([0, 2, 3], TARGET, 300);
    gliding.orbit.setEnabled(false);
    await glide;
    expect(gliding.orbit.moving).toBe(false);
  });

  it('dispose releases the captured pointer', () => {
    const target = makeWithCaptureMocks();
    pointer(target, 'pointerdown', 100, 100);
    target.orbit.dispose();
    expect(target.release).toHaveBeenCalledWith(1);
  });

  it('dispose stops reporting motion and resolves a glide in flight', async () => {
    const clock = { ms: 1000 };
    const held = make(clock);
    pointer(held, 'pointerdown', 100, 100);
    pointer(held, 'pointermove', 140, 100);
    held.orbit.dispose();
    expect(held.orbit.moving).toBe(false);

    const gliding = make();
    const glide = gliding.orbit.glideTo([0, 2, 3], TARGET, 300);
    gliding.orbit.dispose();
    await glide;
    expect(gliding.orbit.moving).toBe(false);
  });

  it('an unchanged fov never recomputes the projection matrix', async () => {
    const target = make();
    const spy = vi.spyOn(target.camera, 'updateProjectionMatrix');
    target.orbit.placeAt([2, 1.6, 3], TARGET);
    target.orbit.setPose([0, 1.7, 4.2], TARGET, 40);
    const glide = target.orbit.glideTo([0, 2, 3], TARGET, 300);
    target.orbit.update(150);
    target.orbit.update(150);
    expect(spy).not.toHaveBeenCalled();
    await glide;
    target.orbit.setPose([0, 1.7, 4.2], TARGET, 55);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
