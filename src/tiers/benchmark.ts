// The calibration benchmark that decides whether a discrete GPU earns the high tier.

import { FrameTimes } from '../proof/frametime';
import type { Loop } from '../loop/loop';

const DEFAULT_DURATION_MS = 2000;
const WARMUP_FRAMES = 3;

export interface BenchmarkOptions {
  /** Draws one frame; the caller supplies it so the benchmark stays renderer-agnostic. */
  renderFrame: () => void;
  durationMs?: number;
  now?: () => number;
  raf?: (cb: (t: number) => void) => number;
  /** Suspends the regular drawer until calibration resolves or rejects. */
  loop?: Pick<Loop, 'running' | 'start' | 'stop'>;
}

/**
 * Renders frames through raf for durationMs, measures each renderFrame call with now(), drops
 * the first three frames (warm-up: shader compilation and first-touch allocations) and resolves
 * the p95 of the remaining work times. The work time is the render call duration, not the
 * interval between frames, so a vsync-bound device does not read as slow.
 * A thrown render rejects the benchmark and stops scheduling frames.
 */
export function runBenchmark(options: BenchmarkOptions): Promise<number> {
  const renderFrame = options.renderFrame;
  const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
  const now = options.now ?? ((): number => performance.now());
  const raf = options.raf ?? ((cb: (t: number) => void): number => requestAnimationFrame(cb));
  const resumeLoop = options.loop?.running === true;
  if (resumeLoop) options.loop?.stop();

  return new Promise<number>((resolve, reject) => {
    const frames = new FrameTimes();
    let drawn = 0;
    const startedAt = now();

    function tick(): void {
      const frameStart = now();
      try {
        renderFrame();
      } catch (error) {
        reject(error);
        return;
      }
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
  }).finally(() => {
    // stop() preserves animation and invalidation, including input received during calibration.
    if (resumeLoop) options.loop?.start();
  });
}
