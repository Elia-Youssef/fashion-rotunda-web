import { describe, expect, it, vi } from 'vitest';
import { runBenchmark } from '../../src/tiers/benchmark';

describe('runBenchmark', () => {
  it.each([
    { phase: 'first warm-up', throwOnFrame: 1 },
    { phase: 'later measured', throwOnFrame: 5 },
  ])('rejects with the $phase frame error and stops scheduling', async ({ throwOnFrame }) => {
    const error = new Error('benchmark render failed');
    const callbacks: ((t: number) => void)[] = [];
    let clock = 0;
    let draws = 0;
    const renderFrame = (): void => {
      draws += 1;
      if (draws === throwOnFrame) {
        throw error;
      }
      clock += 1;
    };
    const raf = vi.fn((cb: (t: number) => void): number => callbacks.push(cb));
    const resolved = vi.fn();
    const rejected = vi.fn();
    const benchmark = runBenchmark({ renderFrame, durationMs: 10, now: () => clock, raf });
    void benchmark.then(resolved, rejected);

    for (let frame = 1; frame <= throwOnFrame; frame += 1) {
      expect(callbacks).toHaveLength(1);
      const callback = callbacks.shift()!;
      expect(() => callback(0)).not.toThrow();
    }

    await expect(benchmark).rejects.toBe(error);
    expect(draws).toBe(throwOnFrame);
    expect(raf).toHaveBeenCalledTimes(throwOnFrame);
    expect(callbacks).toHaveLength(0);
    expect(rejected).toHaveBeenCalledExactlyOnceWith(error);
    expect(resolved).not.toHaveBeenCalled();
  });

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
    const callbacks: ((t: number) => void)[] = [];
    const raf = vi.fn((cb: (t: number) => void): number => callbacks.push(cb));
    const resolved = vi.fn();
    const benchmark = runBenchmark({ renderFrame, durationMs: 15, now, raf });
    void benchmark.then(resolved);
    expect(draws).toBe(0);
    expect(resolved).not.toHaveBeenCalled();
    for (let frame = 1; frame <= costs.length; frame += 1) {
      expect(callbacks).toHaveLength(1);
      callbacks.shift()!(0);
      await Promise.resolve();
      if (frame < costs.length) {
        expect(resolved).not.toHaveBeenCalled();
      }
    }
    const p95 = await benchmark;
    // Cumulative clock after the six frames is 15, so the run stops after frame 6.
    expect(draws).toBe(6);
    expect(p95).toBe(1);
    expect(raf).toHaveBeenCalledTimes(6);
    expect(callbacks).toHaveLength(0);
    expect(resolved).toHaveBeenCalledExactlyOnceWith(1);
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
