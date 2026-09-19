import { describe, expect, it } from 'vitest';
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
});
