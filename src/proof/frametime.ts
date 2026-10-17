// Frame work-time statistics for the proof panel and the resolution scaler.

/** Rolling CPU and GPU proof window, retaining the most recent 240 frame samples. */
export const DEFAULT_CAPACITY = 240;
const ascending = (a: number, b: number): number => a - b;

/**
 * Ring buffer of frame work times (render call duration only, never the wait between frames).
 * The window is the most recent `capacity` samples; pushing a full buffer drops the oldest.
 */
export class FrameTimes {
  private readonly samples: number[];
  private readonly sorted: number[];
  private dirty = false;
  private next = 0;
  private filled = 0;

  constructor(capacity?: number) {
    this.samples = new Array<number>(capacity ?? DEFAULT_CAPACITY);
    this.sorted = new Array<number>(this.samples.length);
  }

  push(workMs: number): void {
    this.dirty = true;
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
    this.dirty = false;
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
    if (this.dirty) {
      // Sort only the valid prefix, using the ring's physical order just as the copied window did.
      this.sorted.length = this.filled;
      for (let i = 0; i < this.filled; i += 1) {
        this.sorted[i] = this.samples[i];
      }
      this.sorted.sort(ascending);
      this.dirty = false;
    }
    return this.sorted;
  }
}
