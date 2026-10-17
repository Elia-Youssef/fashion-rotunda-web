// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { canvas, countAnimating, make, pointer } from '../support/camera-mount';
import { createLoop } from '../../src/loop/loop';

// The turntable and the animation hold: yaw publication, the moving report, and the loop's
// setAnimating contract while the turntable runs and stops and through an orbit glide.

const DEG = Math.PI / 180;

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

  it.each([
    { initialYaw: 0, frameCap: null },
    { initialYaw: 1, frameCap: null },
    { initialYaw: 0, frameCap: 30 },
    { initialYaw: 1, frameCap: 30 },
  ])('advances yaw on delayed frames from $initialYaw with cap $frameCap', ({ initialYaw, frameCap }) => {
    vi.useFakeTimers();
    // The RAF double delivers no frame in the old five-second yaw window, then slow and
    // irregular callbacks. A 30 ms callback also exercises the 30 fps cap's skipped tick.
    const delays = [6000, 50, 2000, 30, 2500, 6000, 1200];
    const normalFrameMs = 1000 / 60;
    const render = vi.fn((dtMs: number) => current.update(dtMs));
    const liveLoop = createLoop({
      render,
      frameCap,
      diagnostics: true,
      now: () => Date.now(),
      raf: (callback) => window.setTimeout(() => callback(Date.now()), delays.shift() ?? normalFrameMs),
      caf: (id) => window.clearTimeout(id),
    });
    const { showroom, mount: current } = make({ loop: liveLoop, search: '?attract=0' });
    let wakeOpen = true;
    try {
      current.turntable.setYaw(initialYaw);
      liveLoop.start();
      current.turntable.start();
      // The input window expires before any frame arrives. Motion retains ownership, just as
      // the main loop's four-second wake callback requires.
      window.setTimeout(() => {
        wakeOpen = false;
        if (!current.moving) liveLoop.setAnimating(false);
      }, 4000);
      vi.advanceTimersByTime(5000);
      expect(wakeOpen).toBe(false);
      expect(render).not.toHaveBeenCalled();
      expect(current.turntable.yaw).toBe(initialYaw);
      expect(liveLoop.diagnostics?.()).toMatchObject({ animating: true, scheduled: true });

      vi.advanceTimersByTime(1000);
      expect(render).toHaveBeenCalledExactlyOnceWith(0);
      expect(current.turntable.yaw).toBe(initialYaw);
      vi.advanceTimersByTime(50);
      expect(showroom.lookYaw).toBeCloseTo(initialYaw + DEG, 12);
      vi.advanceTimersByTime(2000);
      // Only 0.052 rad after 8.05 seconds: a healthy bounded update cannot satisfy a
      // wall-time threshold of 0.1 rad. Two completed positive-dt frames do prove progress.
      expect(render).toHaveBeenCalledTimes(3);
      expect(showroom.lookYaw).toBeCloseTo(initialYaw + 3 * DEG, 12);
      const before = showroom.lookYaw;
      vi.advanceTimersByTime(30);
      expect(render).toHaveBeenCalledTimes(frameCap === null ? 4 : 3);
      vi.advanceTimersByTime(2500);
      expect(render).toHaveBeenCalledTimes(frameCap === null ? 5 : 4);
      expect(showroom.lookYaw).toBeCloseTo(initialYaw + (frameCap === null ? 5.6 : 5) * DEG, 12);
      expect(showroom.lookYaw).toBeGreaterThan(before);
      expect(canvas.dataset.yaw).toBe(showroom.lookYaw.toFixed(3));
      expect(liveLoop.diagnostics?.()).toMatchObject({ animating: true, scheduled: true });

      // A later RAF gap also leaves a previously advancing yaw unchanged for five seconds.
      // Frame delivery and yaw advancement must be separate checks for this case too.
      const held = showroom.lookYaw;
      const framesBeforeGap = render.mock.calls.length;
      vi.advanceTimersByTime(5000);
      expect(render).toHaveBeenCalledTimes(framesBeforeGap);
      expect(showroom.lookYaw).toBe(held);
      expect(liveLoop.diagnostics?.()).toMatchObject({ animating: true, scheduled: true });
      vi.advanceTimersByTime(1000 + 1200);
      expect(render).toHaveBeenCalledTimes(framesBeforeGap + 2);
      expect(showroom.lookYaw).toBeGreaterThan(held);
      expect(canvas.dataset.yaw).toBe(showroom.lookYaw.toFixed(3));

      current.turntable.stop();
      const stopped = showroom.lookYaw;
      // One cap interval plus the next RAF opportunity also covers integer timer rounding.
      const stopDeadlineMs = (frameCap === null ? 0 : 1000 / frameCap) + normalFrameMs;
      vi.advanceTimersByTime(stopDeadlineMs);
      expect(liveLoop.diagnostics?.()).toMatchObject({ animating: false, scheduled: false });
      vi.advanceTimersByTime(6000);
      expect(showroom.lookYaw).toBe(stopped);
    } finally {
      current.dispose();
      liveLoop.stop();
      vi.useRealTimers();
    }
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
});
