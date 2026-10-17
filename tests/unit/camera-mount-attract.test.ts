// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { canvas, countAnimating, make, pointer } from '../support/camera-mount';
import { attractIdleMsFromSearch } from '../../src/camera/mount';
import type { OrbitHandle } from '../../src/camera/orbit';

// The idle attract tour: the attractIdle delay parsing, the placement of held poses while the
// tour runs, and the placement that must happen on the first tick after a restart.

afterEach(() => vi.unstubAllGlobals());

function motionPreference(matches: boolean) {
  const query = Object.assign(new EventTarget(), { matches });
  vi.stubGlobal('matchMedia', () => query);
  return {
    query,
    change(reduced: boolean): void {
      query.matches = reduced;
      query.dispatchEvent(Object.assign(new Event('change'), { matches: reduced }));
    },
  };
}

describe('mountCamera', () => {
  it.each([false, true])('prevents an explicitly enabled tour under reduced motion (touch=%s)', (isTouch) => {
    motionPreference(true);
    let currentTime = 0;
    const { camera, mount: current } = make({
      isTouch, now: () => currentTime, search: '?attract=1&attractIdle=100',
    });
    const initialPosition = camera.position.toArray();
    const place = vi.spyOn(current.orbit, 'placeAt');
    for (const moment of [100, 1_600, 10_000]) {
      currentTime = moment;
      current.update(0);
      expect(current.attract.running).toBe(false);
      expect(current.moving).toBe(false);
      expect(camera.position.toArray()).toEqual(initialPosition);
      expect(canvas.dataset.attract).toBe('0');
    }
    expect(place).not.toHaveBeenCalled();
  });

  it('stops a moving tour on preference change and can tour after motion is allowed again', () => {
    const motion = motionPreference(false);
    let currentTime = 0;
    const { camera, loop, mount: current } = make({
      now: () => currentTime, search: '?attract=1&attractIdle=100',
      views: {
        proof: { position: [0, 1.7, 4.2], target: [0, 1, 0], fov: 40 },
        entrance: { position: [0, 2.2, 6.2], target: [0, 1, 0], fov: 52 },
      },
    });
    currentTime = 100;
    current.update(0);
    currentTime = 1_600;
    current.update(0);
    expect(current.attract.running).toBe(true);
    expect(camera.position.z).toBeGreaterThan(4.2);
    expect(camera.position.z).toBeLessThan(6.2);
    const stopped = camera.position.toArray();
    const stoppedFov = camera.fov;
    motion.change(true);
    expect(current.attract.running).toBe(false);
    expect(current.moving).toBe(false);
    expect(canvas.dataset.attract).toBe('0');
    expect(loop.setAnimating).toHaveBeenLastCalledWith(false);
    currentTime = 10_000;
    current.update(100);
    expect(camera.position.toArray()).toEqual(stopped);
    expect(camera.fov).toBe(stoppedFov);
    expect(current.attract.running).toBe(false);
    motion.change(false);
    currentTime = 10_099;
    current.update(0);
    expect(current.attract.running).toBe(false);
    currentTime = 10_100;
    current.update(0);
    expect(current.attract.running).toBe(true);
    currentTime = 13_100;
    current.update(0);
    expect(camera.position.z).toBeCloseTo(6.2, 6);
    expect(camera.fov).toBe(52);
  });

  it('removes the preference listener on camera disposal and ignores later changes', () => {
    const motion = motionPreference(false);
    const add = vi.spyOn(motion.query, 'addEventListener');
    const remove = vi.spyOn(motion.query, 'removeEventListener');
    const { loop, mount: current } = make();
    const apply = vi.spyOn(current.attract, 'setReducedMotion');
    motion.change(true);
    expect(apply).toHaveBeenCalledExactlyOnceWith(true);
    const listener = add.mock.calls.find(([type]) => type === 'change')?.[1];
    expect(listener).toEqual(expect.any(Function));
    current.dispose();
    expect(remove).toHaveBeenCalledWith('change', listener);
    loop.invalidate.mockClear();
    motion.change(false);
    expect(apply).toHaveBeenCalledOnce();
    expect(loop.invalidate).not.toHaveBeenCalled();
    expect(canvas.dataset.attract).toBeUndefined();
  });

  it('uses the default idle delay for malformed attractIdle values', () => {
    expect(attractIdleMsFromSearch('?attractIdle=not-a-number')).toBe(60_000);
    expect(attractIdleMsFromSearch('?attractIdle=Infinity')).toBe(60_000);
    expect(attractIdleMsFromSearch('?attractIdle=0')).toBe(60_000);
    expect(attractIdleMsFromSearch('?attractIdle=25')).toBe(100);
    expect(attractIdleMsFromSearch('?attractIdle=750')).toBe(750);
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
    // Each tour starts at the same source pose, so the previous placement cache must not
    // swallow the restarted tour's first pose and leave the camera where the visitor dragged it.
    let currentTime = 0;
    const { camera, mount: current } = make({
      now: () => currentTime,
      search: '?attract=1&attractIdle=2000',
      views: {
        proof: { position: [0, 1.7, 4.2], target: [0, 1, 0], fov: 40 },
        entrance: { position: [0, 2.2, 6.2], target: [0, 1, 0], fov: 52 },
      },
    });

    // Tour start: the glide begins at the proof pose.
    currentTime = 2000;
    current.update(0);
    expect(canvas.dataset.attract).toBe('1');
    expect(camera.position.y).toBeCloseTo(1.7, 6);
    expect(camera.position.z).toBeCloseTo(4.2, 6);

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

    // Idle again: the tour restarts on the same proof pose. The first restarted tick
    // must place the camera, whatever the previous tour left in the skip cache.
    currentTime += 2100;
    current.update(0);
    expect(canvas.dataset.attract).toBe('1');
    expect(camera.position.x).toBeCloseTo(0, 6);
    expect(camera.position.y).toBeCloseTo(1.7, 6);
    expect(camera.position.z).toBeCloseTo(4.2, 6);
  });
});
