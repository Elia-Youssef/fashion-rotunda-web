// The calibration benchmark that decides whether a discrete GPU earns the high tier.

import { FrameTimes } from '../proof/frametime';

const DEFAULT_DURATION_MS = 2000;
const WARMUP_FRAMES = 3;

export interface BenchmarkOptions {
  /** Draws one frame; the caller supplies it so the benchmark stays renderer-agnostic. */
  renderFrame: () => void;
  durationMs?: number;
  now?: () => number;
  raf?: (cb: (t: number) => void) => number;
}

/**
 * Renders frames through raf for durationMs, measures each renderFrame call with now(), drops
 * the first three frames (warm-up: shader compilation and first-touch allocations) and resolves
 * the p95 of the remaining work times. The work time is the render call duration, not the
 * interval between frames, so a vsync-bound device does not read as slow.
 */
export function runBenchmark(options: BenchmarkOptions): Promise<number> {
  const renderFrame = options.renderFrame;
  const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
  const now = options.now ?? ((): number => performance.now());
  const raf = options.raf ?? ((cb: (t: number) => void): number => requestAnimationFrame(cb));

  return new Promise<number>((resolve) => {
    const frames = new FrameTimes();
    let drawn = 0;
    const startedAt = now();

    function tick(): void {
      const frameStart = now();
      renderFrame();
      const frameEnd = now();
      drawn += 1;
      if (drawn > WARMUP_FRAMES) {
        frames.push(frameEnd - frameStart);
      }
      if (frameEnd - startedAt >= durationMs) {
        resolve(frames.p95());
        return;
      }
      raf(tick);
    }

    raf(tick);
  });
}
