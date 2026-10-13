import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLoop } from '../../src/loop/loop';
import type { Page } from '@playwright/test';
import { waitForLoopIdle } from '../e2e/support/ready';

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

describe('pull-only loop diagnostics', () => {
  function diagnosticLoop(h: Harness, render = vi.fn(), frameCap: number | null = null) {
    return createLoop({ render, frameCap, raf: h.raf, caf: h.caf, now: h.now, diagnostics: true });
  }

  it('omits the reader without the diagnostic switch', () => {
    const loop = makeLoop(makeHarness(), vi.fn(), null);
    expect(Object.hasOwn(loop, 'diagnostics')).toBe(false);
  });

  it('reports running independently of scheduling and preserves owed work after stop', () => {
    const h = makeHarness();
    const loop = diagnosticLoop(h);
    expect(loop.diagnostics!()).toEqual({ running: false, scheduled: false, animating: false, invalidated: false });
    loop.start();
    expect(loop.diagnostics!().running).toBe(true);
    loop.invalidate();
    loop.stop();
    expect(loop.diagnostics!()).toEqual({ running: false, scheduled: false, animating: false, invalidated: true });
  });

  it('reports scheduled and invalidated work even when delivery is stalled', () => {
    const h = makeHarness();
    const render = vi.fn();
    const loop = diagnosticLoop(h, render);
    loop.start();
    loop.invalidate();
    h.advance(10_000); // Deliberately never pump the owed RAF.
    expect(render).not.toHaveBeenCalled();
    expect(loop.diagnostics!()).toEqual({ running: true, scheduled: true, animating: false, invalidated: true });
    const detached = loop.diagnostics!();
    detached.invalidated = false;
    expect(loop.diagnostics!().invalidated).toBe(true);
    h.pump();
    expect(loop.diagnostics!()).toEqual({ running: true, scheduled: false, animating: false, invalidated: false });
  });

  it('keeps cap-deferred frames owed and scheduled', () => {
    const h = makeHarness();
    const render = vi.fn();
    const loop = diagnosticLoop(h, render, 30);
    loop.start();
    loop.invalidate();
    h.pump();
    loop.invalidate();
    h.advance(20);
    h.pump();
    expect(render).toHaveBeenCalledTimes(1);
    expect(loop.diagnostics!()).toEqual({ running: true, scheduled: true, animating: false, invalidated: true });
  });

  it('reports continuous animation and its cancellation separately from invalidation', () => {
    const h = makeHarness();
    const loop = diagnosticLoop(h);
    loop.start();
    loop.setAnimating(true);
    h.pump();
    expect(loop.diagnostics!()).toEqual({ running: true, scheduled: true, animating: true, invalidated: false });
    loop.setAnimating(false);
    expect(loop.diagnostics!()).toEqual({ running: true, scheduled: false, animating: false, invalidated: false });
  });

  it('reports an invalidation raised during rendering instead of false idle', () => {
    const h = makeHarness();
    const loop = diagnosticLoop(h, vi.fn(() => loop.invalidate()));
    loop.start();
    loop.invalidate();
    h.pump();
    expect(loop.diagnostics!()).toEqual({ running: true, scheduled: true, animating: false, invalidated: true });
  });
});

// Executes the helper's browser predicates against a controlled transport. No browser or timers run.
function idleTransport() {
  const state = { initialized: true, idle: true, frames: 1 };
  let requested = false;
  let deliver = true;
  let dishonestIdle = false;
  let installed = true;
  const disposals = vi.fn();
  const polls: { polling: number; timeout: number }[] = [];
  const requests = vi.fn(() => {
    requested = true;
    state.idle = dishonestIdle;
    return state.frames;
  });
  const hooks = { loopState: () => ({ ...state }), requestFrame: requests };
  vi.stubGlobal('window', {
    get archvizE2E() { return installed ? hooks : undefined; },
  });
  const quiet = vi.fn();
  const page = {
    async waitForFunction(fn: (arg: number | undefined) => unknown, arg: number | undefined,
      options: { polling: number; timeout: number }) {
      polls.push(options);
      // Four deterministic polls replace wall-clock waiting in this unit transport.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const result = fn(arg);
        if (result) return { jsonValue: async () => result, dispose: disposals };
        if (requested && deliver) {
          state.frames += 1;
          state.idle = true;
          requested = false;
        }
      }
      throw new Error('diagnostic poll timed out');
    },
    async evaluate(fn: () => unknown) { return fn(); },
    async waitForTimeout(ms: number) { quiet(ms); },
  } as unknown as Page;
  return {
    page, state, polls, quiet, requests, disposals,
    stall(pretendIdle = false) { deliver = false; dishonestIdle = pretendIdle; },
    uninstall() { installed = false; },
  };
}

describe('shared idle proof', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('requests a fresh frame before observing quiet and returns the drawn baseline', async () => {
    const transport = idleTransport();
    transport.quiet.mockImplementation(() => {
      expect(transport.state.frames).toBe(2);
      expect(transport.requests).toHaveBeenCalledTimes(1);
    });
    expect(await waitForLoopIdle(transport.page)).toBe(2);
    expect(transport.quiet).toHaveBeenCalledWith(250);
    expect(transport.polls).toEqual([{ polling: 100, timeout: 60_000 }, { polling: 100, timeout: 5_000 }]);
    expect(transport.disposals).toHaveBeenCalledTimes(2);
  });

  it('rejects incomplete initialization even if old frames exist', async () => {
    const transport = idleTransport();
    transport.state.initialized = false;
    await expect(waitForLoopIdle(transport.page)).rejects.toThrow('diagnostic poll timed out');
    expect(transport.requests).not.toHaveBeenCalled();
  });

  it('rejects owed owner work even when the frame counter is constant', async () => {
    const transport = idleTransport();
    transport.state.idle = false;
    await expect(waitForLoopIdle(transport.page)).rejects.toThrow('diagnostic poll timed out');
    expect(transport.requests).not.toHaveBeenCalled();
  });

  it('rejects a stalled requested frame even if the owner falsely reports idle', async () => {
    const transport = idleTransport();
    transport.stall(true);
    await expect(waitForLoopIdle(transport.page)).rejects.toThrow('diagnostic poll timed out');
    expect(transport.requests).toHaveBeenCalledTimes(1);
    expect(transport.quiet).not.toHaveBeenCalled();
  });

  it('rejects a frame drawn during the quiet observation', async () => {
    const transport = idleTransport();
    transport.quiet.mockImplementation(() => { transport.state.frames += 1; });
    await expect(waitForLoopIdle(transport.page)).rejects.toThrow('during the quiet observation');
  });

  it('rejects owed work during quiet even without a completed frame', async () => {
    const transport = idleTransport();
    transport.quiet.mockImplementation(() => { transport.state.idle = false; });
    await expect(waitForLoopIdle(transport.page)).rejects.toThrow('during the quiet observation');
  });

  it('rejects loss of the initialized handle during quiet', async () => {
    const transport = idleTransport();
    transport.quiet.mockImplementation(() => transport.uninstall());
    await expect(waitForLoopIdle(transport.page)).rejects.toThrow('during the quiet observation');
  });
});
