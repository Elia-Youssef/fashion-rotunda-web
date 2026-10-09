// Frame work-time statistics for the proof panel and the resolution scaler.

const DEFAULT_CAPACITY = 240;

/**
 * Ring buffer of frame work times (render call duration only, never the wait between frames).
 * The window is the most recent `capacity` samples; pushing a full buffer drops the oldest.
 */
export class FrameTimes {
  private readonly samples: number[];
  private next = 0;
  private filled = 0;

  constructor(capacity?: number) {
    this.samples = new Array<number>(capacity ?? DEFAULT_CAPACITY);
  }

  push(workMs: number): void {
    this.samples[this.next] = workMs;
    this.next = (this.next + 1) % this.samples.length;
    if (this.filled < this.samples.length) {
      this.filled += 1;
    }
  }

  get count(): number {
    return this.filled;
  }

  p50(): number {
    return this.percentile(50);
  }

  p95(): number {
    return this.percentile(95);
  }

  clear(): void {
    this.next = 0;
    this.filled = 0;
  }

  /**
   * Nearest-rank percentile on a sorted copy, no interpolation: the value at rank
   * ceil(pct/100 * n) in ascending order. Multiplying before dividing keeps ranks such as
   * 95 of 100 exact, because pct * n is an exactly representable integer here.
   */
  private percentile(pct: number): number {
    if (this.filled === 0) {
      return 0;
    }
    const sorted = this.ordered();
    const rank = Math.min(sorted.length, Math.max(1, Math.ceil((pct * this.filled) / 100)));
    return sorted[rank - 1];
  }

  private ordered(): number[] {
    // While the buffer has not wrapped, the valid samples are the first `filled` slots.
    return this.samples.slice(0, this.filled).sort((a, b) => a - b);
  }
}
