// Goal G2.8 and G6.4: GPU frame-time ring buffer driven by renderer timestamp queries.

export interface GpuTimes {
  /** Records the last resolved GPU time of a frame; called once per drawn frame after the resolve. */
  push(ms: number): void;
  p50(): number | null;
  p95(): number | null;
  /** True once a non-zero reading arrived; false means this backend gives none. */
  readonly available: boolean;
  /** Empties the window, keeping `available`; the Measure run calls it so the percentiles are its own. */
  clear(): void;
}

class GpuTimesBuffer implements GpuTimes {
  private readonly samples: number[];
  private next = 0;
  private filled = 0;
  private hasNonZero = false;
  private lastPushed: number | null = null;

  constructor(windowSize: number) {
    const size = Math.max(1, Math.floor(windowSize));
    this.samples = new Array<number>(size);
  }

  get available(): boolean {
    return this.hasNonZero;
  }

  /**
   * One GPU reading must enter the window once, however many frames read it. The pool answers a
   * resolve that is still in flight with the previous number rather than with a new one:
   * WebGPUTimestampQueryPool.resolveQueriesAsync returns `this.lastValue` when there is nothing to
   * resolve (line 100) and returns the in-flight `this.pendingResolve` promise when a resolve is
   * already running (lines 104-106), `lastValue` itself only moving at line 234; its error paths
   * (lines 136, 144, 179, 194, 248) return `lastValue` too. Backend.resolveTimestampsAsync then
   * writes whatever came back into `renderer.info.render.timestamp` (Backend.js line 625), so the
   * composition root reads the same number on every frame between two real resolves. A value
   * exactly equal to the last one pushed is therefore that repeat, and is dropped. Two consecutive
   * frames whose GPU time agrees to the full float are indistinguishable from it and are dropped
   * as well; at the nanosecond resolution of the query that costs one sample, not a percentile.
   */
  push(ms: number): void {
    if (ms <= 0 || ms === this.lastPushed) {
      return;
    }
    this.lastPushed = ms;
    this.hasNonZero = true;
    this.samples[this.next] = ms;
    this.next = (this.next + 1) % this.samples.length;
    if (this.filled < this.samples.length) {
      this.filled += 1;
    }
  }

  p50(): number | null {
    return this.percentile(50);
  }

  p95(): number | null {
    return this.percentile(95);
  }

  /**
   * The window empties but `lastPushed` stays: the pool's last value is still the one the next
   * frames will read back until a fresh resolve lands, and it must not re-enter the new window.
   */
  clear(): void {
    this.next = 0;
    this.filled = 0;
  }

  /**
   * Nearest-rank percentile matching FrameTimes: value at rank ceil(pct/100 * n) in ascending order.
   */
  private percentile(pct: number): number | null {
    if (!this.hasNonZero || this.filled === 0) {
      return null;
    }
    const sorted = this.samples.slice(0, this.filled).sort((a, b) => a - b);
    const rank = Math.min(sorted.length, Math.max(1, Math.ceil((pct * this.filled) / 100)));
    return sorted[rank - 1];
  }
}

export function createGpuTimes(windowSize: number): GpuTimes {
  return new GpuTimesBuffer(windowSize);
}

let timestampWarned = false;

/** Logs at most one warning when timestamp resolution fails (e.g. backend without the feature). */
export function handleTimestampError(error: unknown): void {
  if (!timestampWarned) {
    timestampWarned = true;
    console.warn('[archviz] timestamp resolve failed', error);
  }
}
