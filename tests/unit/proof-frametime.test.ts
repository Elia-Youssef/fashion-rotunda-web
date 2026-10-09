import { describe, expect, it, vi } from 'vitest';
import { FrameTimes } from '../../src/proof/frametime';

describe('FrameTimes', () => {
  it('returns 0 percentiles and count 0 when empty', () => {
    const frames = new FrameTimes();
    expect(frames.count).toBe(0);
    expect(frames.p50()).toBe(0);
    expect(frames.p95()).toBe(0);
  });

  it('computes nearest-rank p50 and p95 on the integers 1 to 100', () => {
    const frames = new FrameTimes();
    for (let i = 1; i <= 100; i += 1) {
      frames.push(i);
    }
    expect(frames.count).toBe(100);
    expect(frames.p50()).toBe(50);
    expect(frames.p95()).toBe(95);
  });

  it('computes p50 and p95 with nearest rank on a small odd count', () => {
    const frames = new FrameTimes();
    frames.push(30);
    frames.push(10);
    frames.push(20);
    // n = 3: p50 rank ceil(1.5) = 2 -> 20; p95 rank ceil(2.85) = 3 -> 30.
    expect(frames.p50()).toBe(20);
    expect(frames.p95()).toBe(30);
  });

  it('drops the oldest samples beyond the configured capacity', () => {
    const frames = new FrameTimes(3);
    frames.push(1);
    frames.push(2);
    frames.push(3);
    frames.push(4);
    expect(frames.count).toBe(3);
    // Contents are 2, 3, 4: p50 rank 2 -> 3, p95 rank 3 -> 4.
    expect(frames.p50()).toBe(3);
    expect(frames.p95()).toBe(4);
  });

  it('keeps the last 240 samples at the default capacity', () => {
    const frames = new FrameTimes();
    for (let i = 1; i <= 300; i += 1) {
      frames.push(i);
    }
    expect(frames.count).toBe(240);
    // Contents are 61..300: p50 is sample 120 -> 180, p95 is sample 228 -> 288.
    expect(frames.p50()).toBe(180);
    expect(frames.p95()).toBe(288);
  });

  it('clears back to the empty state and refills after the ring has wrapped', () => {
    const frames = new FrameTimes(2);
    frames.push(5);
    frames.push(6);
    frames.push(7);
    frames.clear();
    expect(frames.count).toBe(0);
    expect(frames.p50()).toBe(0);
    expect(frames.p95()).toBe(0);
    frames.push(9);
    expect(frames.count).toBe(1);
    expect(frames.p95()).toBe(9);
  });

  it('matches the original copy and sort over 10000 generated sequences, wraps and refills', () => {
    // Fixed-seed LCG makes failures reproducible; modes exercise numeric sort's stable ties and NaN.
    let seed = 0x12345678;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let sequence = 0; sequence < 10_000; sequence += 1) {
      const capacity = sequence % 1000 === 0 ? 240 : 1 + Math.floor(random() * 16);
      const frames = new FrameTimes(capacity);
      const samples = new Array<number>(capacity);
      let next = 0;
      let filled = 0;
      const actual: number[] = [];
      const expected: number[] = [];
      for (let i = 0; i < capacity * 3 + 3; i += 1) {
        if (i === capacity * 2 + 1) {
          frames.clear();
          next = 0;
          filled = 0;
          actual.push(frames.p50(), frames.p95());
          expected.push(0, 0);
        }
        const value = [
          random() * 100,
          i,
          -i,
          7,
          i % capacity === 0 ? 1e10 : 0,
          [NaN, Infinity, -Infinity, -0, 0, 1][i % 6],
        ][sequence % 6];
        frames.push(value);
        samples[next] = value;
        next = (next + 1) % capacity;
        filled = Math.min(filled + 1, capacity);
        const sorted = samples.slice(0, filled).sort((a, b) => a - b);
        expected.push(sorted[Math.ceil((50 * filled) / 100) - 1], sorted[Math.ceil((95 * filled) / 100) - 1]);
        // Repeat reads and alternate the first reader to exercise the shared cached window.
        if (i % 2 === 0) frames.p95();
        actual.push(frames.p50(), frames.p95());
      }
      expect(actual, `sequence ${sequence}, capacity ${capacity}`).toEqual(expected);
    }
  });

  it('sorts one reusable scratch at most once per new sample, including clear and wrap', () => {
    const frames = new FrameTimes(3);
    const sort = vi.spyOn(Array.prototype, 'sort');
    const counts: number[] = [];
    let contexts: unknown[];
    try {
      frames.p50(); frames.p95();
      counts.push(sort.mock.calls.length);
      for (let i = 0; i < 8; i += 1) {
        frames.push(8 - i);
        frames.p95(); frames.p50(); frames.p95();
        counts.push(sort.mock.calls.length);
      }
      frames.clear();
      frames.p50(); frames.p95();
      counts.push(sort.mock.calls.length);
      frames.push(9);
      frames.push(10);
      frames.p50(); frames.p95();
      counts.push(sort.mock.calls.length);
      contexts = [...sort.mock.contexts];
    } finally {
      sort.mockRestore();
    }
    expect(counts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 8, 9]);
    expect(new Set(contexts).size).toBe(1);
  });
});
