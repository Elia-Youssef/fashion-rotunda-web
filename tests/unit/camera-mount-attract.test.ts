// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { canvas, countAnimating, make, pointer } from '../support/camera-mount';
import { attractIdleMsFromSearch } from '../../src/camera/mount';
import type { OrbitHandle } from '../../src/camera/orbit';
import type { CameraMountOptions } from '../../src/camera/mount';

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

const SLEEPING_TOUR_IDLE_MS = 6_000;
const INPUT_WAKE_WINDOW_MS = 4_000;

/** No update is delivered unless the camera owes a frame or holds continuous animation. */
function sleepingCamera(options: Partial<CameraMountOptions> = {}) {
  vi.useFakeTimers();
  let invalidated = false;
  let animating = false;
  const loop = {
    invalidate: vi.fn(() => { invalidated = true; }),
    setAnimating: vi.fn((on: boolean) => { animating = on; }),
  };
  const result = make({
    now: () => performance.now(),
    search: `?attract=1&attractIdle=${SLEEPING_TOUR_IDLE_MS}`,
    views: {
      proof: { position: [0, 1.7, 4.2], target: [0, 1, 0], fov: 40 },
      entrance: { position: [0, 2.2, 6.2], target: [0, 1, 0], fov: 52 },
    },
    ...options,
    loop,
  });
  const update = vi.spyOn(result.mount, 'update');
  function frame(dtMs = 0): void {
    if (!invalidated && !animating) return;
    invalidated = false;
    result.mount.update(dtMs);
  }
  // Finish the unrelated walk preload and the initial camera placement frame.
  vi.advanceTimersByTime(0);
  frame();
  update.mockClear();
  loop.invalidate.mockClear();
  return { ...result, loop, update, frame };
}

describe('idle tour wake scheduling', () => {
  afterEach(() => vi.useRealTimers());

  it('wakes a sleeping loop after an idle delay longer than the input wake window', () => {
    const { mount: current, camera, loop, update, frame } = sleepingCamera();
    const initial = camera.position.toArray();
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    expect(vi.getTimerCount()).toBe(1);
    // Unrelated frames must keep the same deadline, without replacing or multiplying timers.
    for (let i = 0; i < 3; i += 1) {
      loop.invalidate();
      frame();
    }
    expect(timeout).not.toHaveBeenCalled();
    update.mockClear();
    loop.invalidate.mockClear();
    vi.advanceTimersByTime(INPUT_WAKE_WINDOW_MS);
    frame();
    vi.advanceTimersByTime(SLEEPING_TOUR_IDLE_MS - INPUT_WAKE_WINDOW_MS - 1);
    frame();
    expect(update).not.toHaveBeenCalled();
    expect(loop.invalidate).not.toHaveBeenCalled();
    expect(current.attract.running).toBe(false);
    vi.advanceTimersByTime(1);
    frame();
    expect(update).toHaveBeenCalledOnce();
    expect(current.attract.running).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1_500);
    frame();
    expect(Math.hypot(
      camera.position.x - initial[0], camera.position.y - initial[1], camera.position.z - initial[2],
    )).toBeGreaterThan(0.25);
    current.dispose();
    timeout.mockRestore();
  });

  it.each(['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'])(
    'moves the sleeping deadline when %s restarts the idle clock', (event) => {
      const { mount: current, loop, frame } = sleepingCamera();
      vi.advanceTimersByTime(INPUT_WAKE_WINDOW_MS);
      window.dispatchEvent(new Event(event));
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(SLEEPING_TOUR_IDLE_MS - INPUT_WAKE_WINDOW_MS);
      frame();
      expect(loop.invalidate).not.toHaveBeenCalled();
      expect(current.attract.running).toBe(false);
      vi.advanceTimersByTime(INPUT_WAKE_WINDOW_MS - 1);
      frame();
      expect(current.attract.running).toBe(false);
      vi.advanceTimersByTime(1);
      frame();
      expect(current.attract.running).toBe(true);
      current.dispose();
    },
  );

  it.each(['disabled', 'reduced motion', 'empty views'])(
    'arms no idle timeout with %s', (condition) => {
      motionPreference(condition === 'reduced motion');
      const { mount: current, update, frame } = sleepingCamera({
        search: `?attract=${condition === 'disabled' ? 0 : 1}&attractIdle=${SLEEPING_TOUR_IDLE_MS}`,
        ...(condition === 'empty views' ? { views: {} } : {}),
      });
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(SLEEPING_TOUR_IDLE_MS * 2);
      frame();
      expect(update).not.toHaveBeenCalled();
      expect(current.attract.running).toBe(false);
      current.dispose();
    },
  );

  it('clears the wait under reduced motion and re-arms a fresh wait when motion returns', () => {
    const motion = motionPreference(false);
    const { mount: current, frame } = sleepingCamera();
    vi.advanceTimersByTime(INPUT_WAKE_WINDOW_MS);
    motion.change(true);
    expect(vi.getTimerCount()).toBe(0);
    frame();
    vi.advanceTimersByTime(SLEEPING_TOUR_IDLE_MS * 2);
    frame();
    expect(current.attract.running).toBe(false);
    motion.change(false);
    expect(vi.getTimerCount()).toBe(1);
    frame();
    vi.advanceTimersByTime(SLEEPING_TOUR_IDLE_MS - 1);
    frame();
    expect(current.attract.running).toBe(false);
    vi.advanceTimersByTime(1);
    frame();
    expect(current.attract.running).toBe(true);
    current.dispose();
  });

  it('clears a disabled wait and wakes on enable even when its deadline has passed', () => {
    const { mount: current, frame } = sleepingCamera();
    current.attract.setEnabled(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(SLEEPING_TOUR_IDLE_MS * 2);
    frame();
    expect(current.attract.running).toBe(false);
    current.attract.setEnabled(true);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(0);
    frame();
    expect(current.attract.running).toBe(true);
    current.dispose();
  });

  it('clears the timeout on dispose and never wakes the disposed loop', () => {
    const { mount: current, loop, frame } = sleepingCamera();
    expect(vi.getTimerCount()).toBe(1);
    current.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(SLEEPING_TOUR_IDLE_MS * 2);
    frame();
    expect(loop.invalidate).not.toHaveBeenCalled();
    current.attract.noteInput();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the wait during turntable and orbit motion and re-arms when they settle', async () => {
    const { mount: current, frame } = sleepingCamera();
    current.turntable.start();
    expect(vi.getTimerCount()).toBe(0);
    current.turntable.stop();
    frame();
    expect(vi.getTimerCount()).toBe(1);
    const glide = current.presets.goTo('entrance', 100);
    expect(vi.getTimerCount()).toBe(0);
    frame(100);
    await glide;
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(SLEEPING_TOUR_IDLE_MS);
    frame();
    expect(current.attract.running).toBe(true);
    current.dispose();
  });

  it('clears the wait for a mode request and walk mode, then re-arms on return to orbit', async () => {
    const { mount: current, frame } = sleepingCamera();
    const walk = current.setMode('walk');
    expect(vi.getTimerCount()).toBe(0);
    for (let i = 0; i < 20; i += 1) frame(100);
    await walk;
    expect(current.mode).toBe('walk');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(SLEEPING_TOUR_IDLE_MS * 2);
    frame();
    expect(current.attract.running).toBe(false);
    const orbit = current.setMode('orbit');
    expect(vi.getTimerCount()).toBe(0);
    for (let i = 0; i < 20; i += 1) frame(100);
    await orbit;
    expect(current.mode).toBe('orbit');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(SLEEPING_TOUR_IDLE_MS);
    frame();
    expect(current.attract.running).toBe(true);
    current.dispose();
  });

  it('clears the wait while Walk loads and re-arms when the request is cancelled', async () => {
    const { mount: current, update, frame } = sleepingCamera({
      createWalkLoader: () => ({
        state: 'loading', session: null,
        ensureReady: () => new Promise<null>(() => {}),
        cancel: () => {},
        onStateChange: () => () => {},
        dispose: () => {},
      }),
    });
    const walk = current.setMode('walk');
    expect(current.pendingMode).toBe('walk');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(SLEEPING_TOUR_IDLE_MS * 2);
    frame();
    expect(update).not.toHaveBeenCalled();
    await current.setMode('orbit');
    await walk;
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(SLEEPING_TOUR_IDLE_MS);
    frame();
    expect(current.attract.running).toBe(true);
    current.dispose();
  });
});

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
