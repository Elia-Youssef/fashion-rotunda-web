// @vitest-environment jsdom
import { PerspectiveCamera } from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { attractIdleMsFromSearch, mountCamera } from '../../src/camera/mount';
import type { CameraMount } from '../../src/camera/mount';
import type { OrbitHandle } from '../../src/camera/orbit';

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

function make(opts?: Partial<Parameters<typeof mountCamera>[0]>) {
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
    collisionUrl: '',
    search: '',
    ...opts,
  });
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
  it('publishes yaw only when its exact three-decimal value changes, including ties and reset', () => {
    const { showroom, mount: current } = make({ search: '?attract=0' });
    const observer = new MutationObserver(() => {});
    observer.observe(canvas, { attributes: true, attributeFilter: ['data-yaw'] });
    const format = vi.spyOn(Number.prototype, 'toFixed');
    let previous: string | undefined;
    const values = [
      0.0001, 0.0002, 0.00049, 0.0005, 0.00051, 0.0015, 1.2345,
      -0.0001, -0.0002, -0.0005, -0.0015, -1.2345,
      1e20, 1e21, -1e21, Infinity, -Infinity, NaN, 0,
    ];
    for (const yaw of values) {
      const expected = yaw.toFixed(3);
      format.mockClear();
      current.turntable.setYaw(yaw);
      expect(canvas.dataset.yaw).toBe(expected);
      expect(showroom.lookYaw).toBe(yaw);
      expect(observer.takeRecords()).toHaveLength(expected !== previous ? 1 : 0);
      if (yaw === 0.0002 || yaw === -0.0002) expect(format).not.toHaveBeenCalled();
      previous = expected;
    }
    current.turntable.start();
    for (let frame = 0; frame < 20; frame += 1) {
      current.update(0.1);
      expect(canvas.dataset.yaw).toBe(current.turntable.yaw.toFixed(3));
      expect(showroom.lookYaw).toBe(current.turntable.yaw);
    }
    current.turntable.stop();
    current.turntable.setYaw(0);
    expect(canvas.dataset.yaw).toBe('0.000');
    format.mockRestore();
    observer.disconnect();
  });

  it('publishes repeated non-finite yaw once, then a finite yaw', () => {
    const yaw = NaN;
    const { mount: current } = make({ search: '?attract=0' });
    const observer = new MutationObserver(() => {});
    observer.observe(canvas, { attributes: true, attributeFilter: ['data-yaw'] });
    try {
      current.turntable.setYaw(yaw);
      expect(canvas.dataset.yaw).toBe(yaw.toFixed(3));
      expect(observer.takeRecords()).toHaveLength(1);
      current.turntable.setYaw(yaw);
      expect(canvas.dataset.yaw).toBe(yaw.toFixed(3));
      expect(observer.takeRecords()).toHaveLength(0);
      current.turntable.setYaw(1.25);
      expect(canvas.dataset.yaw).toBe('1.250');
      expect(observer.takeRecords()).toHaveLength(1);
    } finally {
      observer.disconnect();
    }
  });

  it('uses the default idle delay for malformed attractIdle values', () => {
    expect(attractIdleMsFromSearch('?attractIdle=not-a-number')).toBe(60_000);
    expect(attractIdleMsFromSearch('?attractIdle=Infinity')).toBe(60_000);
    expect(attractIdleMsFromSearch('?attractIdle=0')).toBe(60_000);
    expect(attractIdleMsFromSearch('?attractIdle=25')).toBe(100);
    expect(attractIdleMsFromSearch('?attractIdle=750')).toBe(750);
  });

  it('aborts an in-flight collision request when disposed', () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      () => new Promise<Response>(() => {}),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { mount: current } = make({ collisionUrl: '/content/collision.glb' });
    vi.runAllTimers();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    current.dispose();
    expect(init?.signal?.aborted).toBe(true);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
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

  it('disposes owned Walk input and touch controls through the camera mount', () => {
    const { mount: current } = make({ isTouch: true });
    const walk = current.walk;
    walk.enable();
    expect(document.querySelector('.archviz-joystick-layer')).not.toBeNull();
    current.dispose();
    expect(walk.enabled).toBe(false);
    expect(document.querySelector('.archviz-joystick-layer')).toBeNull();
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
    expect(window.archvizCamera?.walk).toBe(current.walk);
    expect(window.archvizCamera?.presets).toBe(current.presets);
    expect(window.archvizCamera?.attract).toBe(current.attract);
    expect(window.archvizCamera?.mode).toBe('orbit');
    expect(typeof window.archvizCamera?.setMode).toBe('function');
    current.dispose();
    expect(window.archvizCamera).toBeUndefined();
    expect(canvas.dataset.yaw).toBeUndefined();
  });

  it('sets dataset attributes for camera mode and attract', () => {
    const { mount: current } = make();
    expect(canvas.dataset.camera).toBe('orbit');
    expect(canvas.dataset.attract).toBe('0');
    current.dispose();
  });

  it('ten switches in a row end exactly where each mode was left', async () => {
    let currentTime = 1000;
    const { camera, mount: current } = make({
      now: () => currentTime,
    });

    const initialOrbitPos: [number, number, number] = [
      camera.position.x,
      camera.position.y,
      camera.position.z,
    ];
    const initialOrbitTarget: [number, number, number] = [
      current.orbit.target[0],
      current.orbit.target[1],
      current.orbit.target[2],
    ];

    // Modify walk pose when in walk mode to verify it remembers custom poses too
    const customWalkFoot: [number, number, number] = [1.2, 0, 3.4];
    const customWalkYaw = 0.5;
    const customWalkPitch = -0.2;

    // 10 switches total: 5 round trips (orbit -> walk -> orbit)
    for (let round = 0; round < 5; round += 1) {
      // 1. Switch to walk
      const walkPromise = current.setMode('walk');
      expect(current.moving).toBe(true);

      // Advance clock and frames across the 700 ms blend
      for (let t = 0; t < 10; t += 1) {
        currentTime += 100;
        current.update(100);
      }
      await walkPromise;

      expect(current.mode).toBe('walk');
      expect(canvas.dataset.camera).toBe('walk');

      if (round === 0) {
        // Initial walk pose default: [0, 0, 5.5]
        expect(current.walk.foot[0]).toBeCloseTo(0, 5);
        expect(current.walk.foot[1]).toBeCloseTo(0, 5);
        expect(current.walk.foot[2]).toBeCloseTo(5.5, 5);
        // Move walk to custom pose
        current.walk.setPose(customWalkFoot, customWalkYaw, customWalkPitch);
      } else {
        // Must restore where walk was left!
        expect(current.walk.foot[0]).toBeCloseTo(customWalkFoot[0], 5);
        expect(current.walk.foot[1]).toBeCloseTo(customWalkFoot[1], 5);
        expect(current.walk.foot[2]).toBeCloseTo(customWalkFoot[2], 5);
        expect(current.walk.yaw).toBeCloseTo(customWalkYaw, 5);
        expect(current.walk.pitch).toBeCloseTo(customWalkPitch, 5);
      }

      // 2. Switch to orbit
      const orbitPromise = current.setMode('orbit');
      expect(current.moving).toBe(true);

      for (let t = 0; t < 10; t += 1) {
        currentTime += 100;
        current.update(100);
      }
      await orbitPromise;

      expect(current.mode).toBe('orbit');
      expect(canvas.dataset.camera).toBe('orbit');

      // Orbit must be restored to initial orbit pose exactly!
      expect(current.orbit.position[0]).toBeCloseTo(initialOrbitPos[0], 5);
      expect(current.orbit.position[1]).toBeCloseTo(initialOrbitPos[1], 5);
      expect(current.orbit.position[2]).toBeCloseTo(initialOrbitPos[2], 5);
      expect(current.orbit.target[0]).toBeCloseTo(initialOrbitTarget[0], 5);
      expect(current.orbit.target[1]).toBeCloseTo(initialOrbitTarget[1], 5);
      expect(current.orbit.target[2]).toBeCloseTo(initialOrbitTarget[2], 5);
    }
  });

  it('skips the repeated held pose on the tour but keeps holding so the timing survives', () => {
    let currentTime = 0;
    const { camera, loop, mount: current } = make({
      now: () => currentTime,
      search: '?attract=1&attractIdle=100',
      views: {
        proof: { position: [0, 1.7, 4.2], target: [0, 1, 0], fov: 40 },
        entrance: { position: [0, 2.2, 6.2], target: [0, 1, 0], fov: 52 },
      },
    });

    let placeCalls = 0;
    const originalPlaceAt: OrbitHandle['placeAt'] = current.orbit.placeAt.bind(current.orbit);
    Object.assign(current.orbit, {
      placeAt: (...args: Parameters<OrbitHandle['placeAt']>) => {
        placeCalls += 1;
        originalPlaceAt(...args);
      },
    });

    // Before the idle delay the tour is quiet and places nothing.
    current.update(0);
    expect(placeCalls).toBe(0);
    expect(canvas.dataset.attract).toBe('0');

    // Tour start: the first pose, then the mid-glide pose, then the landed pose: three placements.
    currentTime = 100;
    current.update(0);
    expect(placeCalls).toBe(1);
    currentTime = 1600;
    current.update(0);
    expect(placeCalls).toBe(2);
    currentTime = 3100;
    current.update(0);
    expect(placeCalls).toBe(3);
    expect(camera.position.y).toBeCloseTo(2.2, 6);
    expect(camera.position.z).toBeCloseTo(6.2, 6);

    // Ten hold ticks re-report the same pose: none of them may re-place the camera, and every
    // one of them must keep the loop animating so the hold still ends on time.
    const animatingBefore = countAnimating(loop, true);
    for (let holdTick = 0; holdTick < 10; holdTick += 1) {
      currentTime += 100;
      current.update(0);
    }
    expect(placeCalls).toBe(3);
    expect(countAnimating(loop, true)).toBe(animatingBefore + 10);
    expect(canvas.dataset.attract).toBe('1');
    expect(camera.position.y).toBeCloseTo(2.2, 6);
    expect(camera.position.z).toBeCloseTo(6.2, 6);

    // Hold end (4000 ms): the advance re-reports the pose just held, which is already on
    // screen, so it is skipped too; the next tick's glide pose is the fourth placement.
    currentTime = 7100;
    current.update(0);
    expect(placeCalls).toBe(3);
    currentTime = 8100;
    current.update(0);
    expect(placeCalls).toBe(4);
  });

  it('places the camera on the first tick after the tour restarts on the same view', () => {
    // Reduced motion makes every tick of a hold report the same pose, so a skip decision
    // left over from the previous tour would swallow the whole restarted hold and leave the
    // camera wherever the visitor dragged it.
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    let currentTime = 0;
    const { camera, mount: current } = make({
      now: () => currentTime,
      search: '?attract=1&attractIdle=2000',
      views: {
        proof: { position: [0, 1.7, 4.2], target: [0, 1, 0], fov: 40 },
        entrance: { position: [0, 2.2, 6.2], target: [0, 1, 0], fov: 52 },
      },
    });

    // Tour start under reduced motion: an immediate cut to the entrance hold.
    currentTime = 2000;
    current.update(0);
    expect(canvas.dataset.attract).toBe('1');
    expect(camera.position.y).toBeCloseTo(2.2, 6);
    expect(camera.position.z).toBeCloseTo(6.2, 6);

    // The visitor's input stops the tour and drags the orbit away from the held view.
    pointer('pointerdown', 200, 100);
    pointer('pointermove', 300, 100);
    pointer('pointerup', 300, 100);
    current.update(0);
    expect(canvas.dataset.attract).toBe('0');
    expect(camera.position.x).not.toBeCloseTo(0, 6);

    // Drain the release glide so the tour gate (orbit not moving) opens again. The idle
    // delay is long enough that the tour cannot restart while the drain runs.
    let guard = 0;
    do {
      currentTime += 16.7;
      current.update(16.7);
      guard += 1;
    } while (current.orbit.moving && guard < 200);
    expect(current.orbit.moving).toBe(false);

    // Idle again: the tour restarts on the same entrance hold. The first restarted tick
    // must place the camera, whatever the previous tour left in the skip cache.
    currentTime += 2100;
    current.update(0);
    expect(canvas.dataset.attract).toBe('1');
    expect(camera.position.x).toBeCloseTo(0, 6);
    expect(camera.position.y).toBeCloseTo(2.2, 6);
    expect(camera.position.z).toBeCloseTo(6.2, 6);
    vi.unstubAllGlobals();
  });
});
