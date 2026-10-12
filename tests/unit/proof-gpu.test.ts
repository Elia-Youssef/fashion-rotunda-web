import { describe, expect, it, vi } from 'vitest';
import { createGpuTimes } from '../../src/proof/gpu';

describe('createGpuTimes', () => {
  it('matches copy-and-sort ranks through fixed series, wrap, clear and non-finite readings', () => {
    const values = [30, 10, 20, 20, 0, -5, 4, Infinity, NaN, NaN, 9, 12];
    for (const capacity of [1, 3, 10]) {
      const gpu = createGpuTimes(capacity);
      const samples = new Array<number>(capacity);
      let next = 0;
      let filled = 0;
      let last: number | null = null;
      for (let index = 0; index < values.length * 2; index += 1) {
        if (index === values.length) {
          gpu.clear();
          next = 0;
          filled = 0;
          expect(gpu.p50()).toBeNull();
          expect(gpu.p95()).toBeNull();
        }
        const value = values[index % values.length];
        gpu.push(value);
        if (value > 0 || Number.isNaN(value)) {
          if (value !== last) {
            last = value;
            samples[next] = value;
            next = (next + 1) % capacity;
            filled = Math.min(filled + 1, capacity);
          }
        }
        const sorted = samples.slice(0, filled).sort((a, b) => a - b);
        for (const pct of [50, 95]) {
          const rank = Math.min(filled, Math.max(1, Math.ceil((pct * filled) / 100)));
          const expected = filled === 0 ? null : sorted[rank - 1];
          expect(pct === 50 ? gpu.p50() : gpu.p95()).toBe(expected);
        }
      }
    }
  });

  it('reuses one sorted window for both ranks and invalidates only on accepted samples', () => {
    const gpu = createGpuTimes(3);
    const sort = vi.spyOn(Array.prototype, 'sort');
    try {
      gpu.push(30);
      gpu.push(10);
      gpu.push(20);
      const read = (): number[] => [gpu.p50()!, gpu.p95()!];
      const first = read();
      const second = read();
      gpu.push(20);
      gpu.push(0);
      const repeated = read();
      expect(sort).toHaveBeenCalledTimes(1);
      expect(first).toEqual([20, 30]);
      expect(second).toEqual(first);
      expect(repeated).toEqual(first);
      gpu.push(40);
      const wrapped = read();
      expect(sort).toHaveBeenCalledTimes(2);
      expect(wrapped).toEqual([20, 40]);
      gpu.clear();
      expect(gpu.p50()).toBeNull();
      expect(gpu.p95()).toBeNull();
      gpu.push(40);
      expect(gpu.p50()).toBeNull();
      gpu.push(5);
      const refilled = read();
      expect(sort).toHaveBeenCalledTimes(3);
      expect(refilled).toEqual([5, 5]);
      expect(gpu.available).toBe(true);
    } finally {
      sort.mockRestore();
    }
  });

  it('starts unavailable with null percentiles when empty', () => {
    const gpu = createGpuTimes(10);
    expect(gpu.available).toBe(false);
    expect(gpu.p50()).toBeNull();
    expect(gpu.p95()).toBeNull();
  });

  it('stays unavailable when only zero readings are pushed', () => {
    const gpu = createGpuTimes(10);
    gpu.push(0);
    gpu.push(0);
    expect(gpu.available).toBe(false);
    expect(gpu.p50()).toBeNull();
    expect(gpu.p95()).toBeNull();
  });

  it('becomes available once a non-zero reading arrives', () => {
    const gpu = createGpuTimes(10);
    gpu.push(0);
    expect(gpu.available).toBe(false);
    gpu.push(8.5);
    expect(gpu.available).toBe(true);
    expect(gpu.p50()).toBe(8.5);
    expect(gpu.p95()).toBe(8.5);
  });

  it('computes nearest-rank p50 and p95 across 100 samples', () => {
    const gpu = createGpuTimes(100);
    for (let i = 1; i <= 100; i += 1) {
      gpu.push(i);
    }
    expect(gpu.available).toBe(true);
    expect(gpu.p50()).toBe(50);
    expect(gpu.p95()).toBe(95);
  });

  it('drops the oldest samples beyond the configured windowSize', () => {
    const gpu = createGpuTimes(3);
    gpu.push(1);
    gpu.push(2);
    gpu.push(3);
    gpu.push(4);
    // Buffer contains 2, 3, 4: p50 rank 2 -> 3, p95 rank 3 -> 4.
    expect(gpu.p50()).toBe(3);
    expect(gpu.p95()).toBe(4);
  });

  it('clears samples while keeping availability', () => {
    const gpu = createGpuTimes(5);
    gpu.push(10);
    gpu.push(20);
    expect(gpu.available).toBe(true);
    gpu.clear();
    expect(gpu.available).toBe(true);
    expect(gpu.p50()).toBeNull();
    expect(gpu.p95()).toBeNull();
    gpu.push(15);
    expect(gpu.p50()).toBe(15);
  });

  // The pool answers a resolve that is still in flight with its previous value, so the same
  // reading arrives on several frames in a row; only the first may enter the window.
  it('ignores a value exactly equal to the last one pushed', () => {
    const gpu = createGpuTimes(10);
    gpu.push(4);
    gpu.push(4);
    gpu.push(4);
    // One sample only: with three, p50 of [4,4,4] would agree by luck, so the count is read
    // through a value that would move the percentile if the repeats had been kept.
    gpu.push(10);
    expect(gpu.p50()).toBe(4);
    expect(gpu.p95()).toBe(10);
    gpu.push(4);
    // 4 again, but not as a repeat of the last push, so it counts: [4, 10, 4].
    expect(gpu.p50()).toBe(4);
    expect(gpu.p95()).toBe(10);
    gpu.push(4);
    expect(gpu.p95()).toBe(10);
  });

  it('keeps the repeat guard across a clear, because the pool still holds that value', () => {
    const gpu = createGpuTimes(10);
    gpu.push(7);
    gpu.clear();
    gpu.push(7);
    expect(gpu.p50()).toBeNull();
    gpu.push(9);
    expect(gpu.p50()).toBe(9);
  });
});
