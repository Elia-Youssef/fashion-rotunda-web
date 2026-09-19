// Goal G0.6: the render loop. Renders only when a frame is owed (invalidate) or continuously
// (setAnimating), enforces the frame cap by skipping early ticks, and reports the render call's
// own duration. raf, caf and now are injectable so tests drive frames by hand.

export interface LoopOptions {
  render: (dtMs: number) => void;
  /** Frames per second; null means uncapped. */
  frameCap: number | null;
  onFrameTime?: (workMs: number) => void;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
  now?: () => number;
}

export interface Loop {
  /** Requests one frame; several calls before a frame still produce one render. */
  invalidate(): void;
  /** Continuous frames while true. */
  setAnimating(on: boolean): void;
  start(): void;
  stop(): void;
  readonly running: boolean;
}

export function createLoop(options: LoopOptions): Loop {
  const render = options.render;
  const frameCap = options.frameCap;
  const onFrameTime = options.onFrameTime;
  const raf = options.raf ?? ((cb: (t: number) => void): number => requestAnimationFrame(cb));
  const caf = options.caf ?? ((id: number): void => cancelAnimationFrame(id));
  const now = options.now ?? ((): number => performance.now());

  let running = false;
  let animating = false;
  let invalidated = false;
  let rafId: number | null = null;
  // Start time of the previous rendered frame; anchors both the cap window and dt.
  let lastFrameAt: number | null = null;

  function schedule(): void {
    if (rafId === null) {
      rafId = raf(tick);
    }
  }

  function tick(): void {
    rafId = null;
    if (!running) {
      return;
    }
    if (!invalidated && !animating) {
      return;
    }
    const frameStart = now();
    const minInterval = frameCap === null ? 0 : 1000 / frameCap;
    if (lastFrameAt !== null && frameStart - lastFrameAt < minInterval) {
      // Too soon under the cap: keep the frame owed and try again on the next tick.
      schedule();
      return;
    }
    invalidated = false;
    const dtMs = lastFrameAt === null ? 0 : frameStart - lastFrameAt;
    lastFrameAt = frameStart;
    render(dtMs);
    const frameEnd = now();
    if (onFrameTime !== undefined) {
      onFrameTime(frameEnd - frameStart);
    }
    if (animating || invalidated) {
      schedule();
    }
  }

  return {
    invalidate(): void {
      invalidated = true;
      if (running) {
        schedule();
      }
    },
    setAnimating(on: boolean): void {
      animating = on;
      if (running && on) {
        schedule();
      } else if (!on && rafId !== null && !invalidated) {
        // No frame owed and no continuous mode: cancel the stray tick instead of letting it
        // fire and find no work.
        const id = rafId;
        rafId = null;
        caf(id);
      }
    },
    start(): void {
      running = true;
      if (animating || invalidated) {
        schedule();
      }
    },
    stop(): void {
      running = false;
      if (rafId !== null) {
        const id = rafId;
        rafId = null;
        caf(id);
      }
    },
    get running(): boolean {
      return running;
    },
  };
}
