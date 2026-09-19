// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameTimes } from '../../src/proof/frametime';

// marks.ts keeps "marked once" state at module scope, so each test re-imports a fresh copy.
beforeEach(() => {
  vi.resetModules();
  performance.clearMarks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadMarks(): Promise<typeof import('../../src/proof/marks')> {
  return await import('../../src/proof/marks');
}

/** A Resource Timing entry shape without casting: a PerformanceEntry with the extra fields. */
interface FakeResourceEntry extends PerformanceEntry {
  readonly transferSize: number;
  readonly responseEnd: number;
}

function fakeResource(name: string, transferSize: number, responseEnd: number): FakeResourceEntry {
  const entry: FakeResourceEntry = {
    name,
    entryType: 'resource',
    startTime: 0,
    duration: responseEnd,
    transferSize,
    responseEnd,
    // Never called; PerformanceEntry declares toJSON so the fake must carry one.
    toJSON: (): FakeResourceEntry => entry,
  };
  return entry;
}

describe('markFirstFrame and firstFrameMs', () => {
  it('returns null before the first frame was marked', async () => {
    const marks = await loadMarks();
    expect(marks.firstFrameMs()).toBeNull();
  });

  it('marks exactly once even when called twice', async () => {
    const marks = await loadMarks();
    marks.markFirstFrame(() => 1000);
    marks.markFirstFrame(() => 9999);
    expect(marks.firstFrameMs()).toBe(1000);
    expect(performance.getEntriesByName('first-frame').length).toBe(1);
  });

  it('uses the injected clock as the mark timestamp', async () => {
    const marks = await loadMarks();
    marks.markFirstFrame(() => 4321);
    expect(marks.firstFrameMs()).toBe(4321);
  });

  it('uses the real clock when no clock is injected', async () => {
    const marks = await loadMarks();
    const before = performance.now();
    marks.markFirstFrame();
    const after = performance.now();
    const value = marks.firstFrameMs();
    if (value === null) {
      throw new Error('markFirstFrame did not produce a readable mark');
    }
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });
});

describe('payloadBytes', () => {
  it('sums transferSize over resource entries and counts zero-size entries as zero', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('scene.bin', 1000, 20),
      fakeResource('lut.png', 2500, 30),
      // Cache hit: transferSize 0 is honest, see the comment in marks.ts.
      fakeResource('cached.bin', 0, 31),
    ]);
    expect(marks.payloadBytes()).toBe(3500);
  });

  it('returns 0 when there are no resource entries', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
    expect(marks.payloadBytes()).toBe(0);
  });

  it('with untilFirstFrame sums only entries that ended at or before the mark', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('before.bin', 700, 24.9),
      fakeResource('at.bin', 300, 25),
      fakeResource('after.bin', 900, 25.1),
    ]);
    marks.markFirstFrame(() => 25);
    expect(marks.payloadBytes(true)).toBe(1000);
  });

  it('with untilFirstFrame returns 0 before the mark exists', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('scene.bin', 1000, 20),
    ]);
    expect(marks.payloadBytes(true)).toBe(0);
  });
});

describe('snapshot', () => {
  it('assembles every field from the input, the marks module and the frame buffer', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('load.bin', 4000, 10),
      fakeResource('later.bin', 6000, 90),
    ]);
    marks.markFirstFrame(() => 50);
    const frames = new FrameTimes();
    for (let i = 1; i <= 10; i += 1) {
      frames.push(i);
    }
    const snap = marks.snapshot({
      info: { render: { drawCalls: 42, triangles: 123456 } },
      backend: 'webgpu',
      tier: 'mid',
      pixelRatio: 2,
      renderScale: 0.85,
      gpuName: 'Intel(R) UHD Graphics',
      frames,
      lookSwitchMs: 250,
    });
    expect(snap).toEqual({
      loadMs: 50,
      payloadBytes: 4000,
      drawCalls: 42,
      triangles: 123456,
      backend: 'webgpu',
      tier: 'mid',
      pixelRatio: 2,
      renderScale: 0.85,
      gpuName: 'Intel(R) UHD Graphics',
      frameP50Ms: 5,
      frameP95Ms: 10,
      lookSwitchMs: 250,
    });
  });

  it('reads null loadMs before the mark and null lookSwitchMs when the field is absent', async () => {
    const marks = await loadMarks();
    const snap = marks.snapshot({
      info: { render: { drawCalls: 0, triangles: 0 } },
      backend: 'webgl2',
      tier: 'base',
      pixelRatio: 1.5,
      renderScale: 1,
      gpuName: 'SwiftShader',
      frames: new FrameTimes(),
    });
    expect(snap.loadMs).toBeNull();
    expect(snap.payloadBytes).toBe(0);
    expect(snap.frameP50Ms).toBe(0);
    expect(snap.frameP95Ms).toBe(0);
    expect(snap.lookSwitchMs).toBeNull();
  });
});
