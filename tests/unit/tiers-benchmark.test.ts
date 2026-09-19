import { describe, expect, it } from 'vitest';
import { runBenchmark } from '../../src/tiers/benchmark';

describe('runBenchmark', () => {
  it('skips the first three frames and resolves the p95 of the measured work', async () => {
    // Frame costs: 10 ms warm-up, then 1 ms steady state. Including the warm-up would give a
    // p95 of 10; the implementation must resolve 1.
    const costs = [10, 1, 1, 1, 1, 1];
    let clock = 0;
    let draws = 0;
    const renderFrame = (): void => {
      clock += costs[draws];
      draws += 1;
    };
    const now = (): number => clock;
    const raf = (cb: (t: number) => void): number => {
      cb(0);
      return 0;
    };
    const p95 = await runBenchmark({ renderFrame, durationMs: 15, now, raf });
    // Cumulative clock after the six frames is 15, so the run stops after frame 6.
    expect(draws).toBe(6);
    expect(p95).toBe(1);
  });

  it('stops once the elapsed clock reaches durationMs', async () => {
    let clock = 0;
    let draws = 0;
    const renderFrame = (): void => {
      clock += 2;
      draws += 1;
    };
    const now = (): number => clock;
    const raf = (cb: (t: number) => void): number => {
      cb(0);
      return 0;
    };
    const p95 = await runBenchmark({ renderFrame, durationMs: 10, now, raf });
    // Each frame moves the clock 2 ms, so the run ends after the 5th frame.
    expect(draws).toBe(5);
    expect(p95).toBe(2);
  });

  it('returns 0 when the duration ends inside the warm-up', async () => {
    let clock = 0;
    const renderFrame = (): void => {
      clock += 5;
    };
    const now = (): number => clock;
    const raf = (cb: (t: number) => void): number => {
      cb(0);
      return 0;
    };
    const p95 = await runBenchmark({ renderFrame, durationMs: 5, now, raf });
    expect(p95).toBe(0);
  });

  it('measures the render call duration, not the wall-clock interval', async () => {
    // The clock jumps 100 ms between frames (the vsync wait) but only moves by the frame cost
    // inside renderFrame. A p95 near 3 proves the wait is excluded; an interval-based reading
    // would be near 103.
    let clock = 0;
    let draws = 0;
    const costs = [1, 1, 1, 3, 3, 3, 3, 3];
    const renderFrame = (): void => {
      clock += costs[draws];
      draws += 1;
    };
    const now = (): number => clock;
    const raf = (cb: (t: number) => void): number => {
      clock += 100;
      cb(0);
      return 0;
    };
    const p95 = await runBenchmark({ renderFrame, durationMs: 800, now, raf });
    // Frames 4..8 cost 3 each and are the samples; the run ends once the clock passes 800.
    expect(draws).toBe(8);
    expect(p95).toBe(3);
  });
});
