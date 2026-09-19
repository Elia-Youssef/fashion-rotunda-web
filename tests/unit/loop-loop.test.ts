import { describe, expect, it, vi } from 'vitest';
import { createLoop } from '../../src/loop/loop';

/**
 * Hand-driven raf/caf/clock. pump() runs the oldest scheduled callback, the way a frame fires,
 * and the harness records every cancelled id so tests can prove stop() cancels.
 */
function makeHarness() {
  let nextId = 1;
  let lastId = 0;
  let clock = 0;
  const scheduled = new Map<number, (t: number) => void>();
  const cancelled: number[] = [];
  return {
    raf(cb: (t: number) => void): number {
      const id = nextId;
      nextId += 1;
      lastId = id;
      scheduled.set(id, cb);
      return id;
    },
    caf(id: number): void {
      cancelled.push(id);
      scheduled.delete(id);
    },
    pump(): void {
      const first = scheduled.entries().next();
      if (first.done) {
        return;
      }
      const [id, cb] = first.value;
      scheduled.delete(id);
      cb(clock);
    },
    now(): number {
      return clock;
    },
    advance(ms: number): void {
      clock += ms;
    },
    scheduledCount(): number {
      return scheduled.size;
    },
    lastScheduledId(): number {
      return lastId;
    },
    cancelledIds(): readonly number[] {
      return cancelled;
    },
  };
}

type Harness = ReturnType<typeof makeHarness>;

function makeLoop(
  h: Harness,
  render: (dtMs: number) => void,
  frameCap: number | null,
  onFrameTime?: (workMs: number) => void,
) {
  const options =
    onFrameTime === undefined
      ? { render, frameCap, raf: h.raf, caf: h.caf, now: h.now }
      : { render, frameCap, onFrameTime, raf: h.raf, caf: h.caf, now: h.now };
  return createLoop(options);
}

describe('createLoop', () => {
  it('renders nothing without invalidate, even when started', () => {
    const h = makeHarness();
    const render = vi.fn();
    const loop = makeLoop(h, render, null);
    loop.start();
    expect(loop.running).toBe(true);
    h.pump();
    expect(render).not.toHaveBeenCalled();
    expect(h.scheduledCount()).toBe(0);
  });

  it('renders exactly one frame per invalidate', () => {
    const h = makeHarness();
    const render = vi.fn();
    const loop = makeLoop(h, render, null);
    loop.start();
    loop.invalidate();
    expect(h.scheduledCount()).toBe(1);
    h.pump();
    expect(render).toHaveBeenCalledTimes(1);
    expect(h.scheduledCount()).toBe(0);
    // A pump with nothing owed renders nothing.
    h.pump();
    expect(render).toHaveBeenCalledTimes(1);
    // Two invalidates before the frame still render once.
    loop.invalidate();
    loop.invalidate();
    expect(h.scheduledCount()).toBe(1);
    h.pump();
    expect(render).toHaveBeenCalledTimes(2);
    expect(h.scheduledCount()).toBe(0);
  });

  it('honours an invalidate that arrived before start', () => {
    const h = makeHarness();
    const render = vi.fn();
    const loop = makeLoop(h, render, null);
    loop.invalidate();
    loop.start();
    expect(h.scheduledCount()).toBe(1);
    h.pump();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('renders continuously while animating and stops scheduling when turned off', () => {
    const h = makeHarness();
    const render = vi.fn();
    const loop = makeLoop(h, render, null);
    loop.start();
    loop.setAnimating(true);
    h.pump();
    h.pump();
    h.pump();
    expect(render).toHaveBeenCalledTimes(3);
    // While animating, the next frame is always already scheduled.
    expect(h.scheduledCount()).toBe(1);
    loop.setAnimating(false);
    expect(h.scheduledCount()).toBe(0);
    h.pump();
    expect(render).toHaveBeenCalledTimes(3);
  });

  it('skips frames that would arrive sooner than 1000 / frameCap after the last render', () => {
    const h = makeHarness();
    const render = vi.fn();
    // Cap 30 fps: at least 33.33 ms between rendered frames.
    const loop = makeLoop(h, render, 30);
    loop.start();
    loop.invalidate();
    h.pump();
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenNthCalledWith(1, 0);
    loop.invalidate();
    h.advance(20); // 20 ms after the last render: too soon, skip but keep the frame owed.
    h.pump();
    expect(render).toHaveBeenCalledTimes(1);
    expect(h.scheduledCount()).toBe(1);
    h.advance(14); // 34 ms after the last render: allowed.
    h.pump();
    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenNthCalledWith(2, 34);
  });

  it('passes the render call duration to onFrameTime, never the wait between frames', () => {
    const h = makeHarness();
    const render = vi.fn((dtMs: number) => {
      // The render itself takes 7 ms of clock time; the frame is owed for much longer.
      void dtMs;
      h.advance(7);
    });
    const onFrameTime = vi.fn();
    const loop = makeLoop(h, render, null, onFrameTime);
    loop.start();
    loop.invalidate();
    h.advance(100); // time between the invalidate and the tick, excluded on purpose
    h.pump();
    expect(onFrameTime).toHaveBeenCalledTimes(1);
    expect(onFrameTime).toHaveBeenCalledWith(7);
  });

  it('stop cancels the pending frame and rejects later work until started again', () => {
    const h = makeHarness();
    const render = vi.fn();
    const loop = makeLoop(h, render, null);
    loop.start();
    loop.invalidate();
    const pendingId = h.lastScheduledId();
    loop.stop();
    expect(loop.running).toBe(false);
    expect(h.cancelledIds()).toEqual([pendingId]);
    h.pump();
    expect(render).not.toHaveBeenCalled();
    loop.invalidate();
    expect(h.scheduledCount()).toBe(0);
    // Restart resumes normal service.
    loop.start();
    expect(h.scheduledCount()).toBe(1);
    h.pump();
    expect(render).toHaveBeenCalledTimes(1);
  });
});
