import { describe, expect, it } from 'vitest';
import { createGpuTimes } from '../../src/proof/gpu';

describe('createGpuTimes', () => {
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
