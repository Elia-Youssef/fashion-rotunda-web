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
  readonly encodedBodySize: number;
  readonly responseEnd: number;
}

function fakeResource(
  name: string, transferSize: number, responseEnd: number, encodedBodySize = transferSize,
): FakeResourceEntry {
  const entry: FakeResourceEntry = {
    name,
    entryType: 'resource',
    startTime: 0,
    duration: responseEnd,
    transferSize,
    encodedBodySize,
    responseEnd,
    // Never called; PerformanceEntry declares toJSON so the fake must carry one.
    toJSON: (): FakeResourceEntry => entry,
  };
  return entry;
}

describe('markFirstFrame and firstFrameMs', () => {
  it('retries absent marks, skips non-marks and caches the first immutable timestamp', async () => {
    const marks = await loadMarks();
    const entries = vi.spyOn(performance, 'getEntriesByName').mockReturnValue([]);
    expect(marks.firstFrameMs()).toBeNull();
    entries.mockReturnValue([
      { ...fakeResource('first-frame', 0, 1), entryType: 'measure', startTime: 3 },
      { ...fakeResource('first-frame', 0, 1), entryType: 'mark', startTime: 0 },
      { ...fakeResource('first-frame', 0, 1), entryType: 'mark', startTime: 99 },
    ]);
    expect(marks.firstFrameMs()).toBe(0);
    expect(marks.firstFrameMs()).toBe(0);
    expect(entries).toHaveBeenCalledTimes(2);
  });

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

describe('cacheState', () => {
  it('returns cold when rotunda.glb has transferSize > 0', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('content/rotunda.glb', 12345, 100),
    ]);
    expect(marks.cacheState()).toBe('cold');
  });

  it('returns warm when rotunda.glb has transferSize 0', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('content/rotunda.glb', 0, 10),
    ]);
    expect(marks.cacheState()).toBe('warm');
  });

  it('returns cold when rotunda.glb is not in entries', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('content/catalog.json', 500, 10),
    ]);
    expect(marks.cacheState()).toBe('cold');
  });
});

describe('snapshot', () => {
  it('reads one current resource buffer per snapshot, retaining late entries and buffer clears', async () => {
    const marks = await loadMarks();
    const resources = vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
    const input = {
      info: { render: { drawCalls: 1, triangles: 2 } }, backend: 'webgpu', tier: 'high',
      pixelRatio: 1, renderScale: 1, gpuName: 'Test GPU', frames: new FrameTimes(),
      gpu: { p50: null, p95: null, available: false }, lookSwitchMs: null, post: 'off',
    };
    const read = (): unknown[] => {
      const snap = marks.snapshot(input);
      return [snap.loadMs, snap.payloadBytes, snap.payloadNowBytes, snap.cacheState];
    };
    expect(read()).toEqual([null, 0, 0, 'cold']);
    marks.markFirstFrame(() => 50);
    resources.mockReturnValue([
      fakeResource('before.bin', 700, 49), fakeResource('at.bin', 300, 50),
      fakeResource('late.bin', 900, 51), fakeResource('content/rotunda.glb', 0, 20),
      fakeResource('second/rotunda.glb', 100, 21),
      { ...fakeResource('missing-end.bin', 200, 1), responseEnd: undefined } as PerformanceEntry,
      { ...fakeResource('missing-size.bin', 0, 1), transferSize: undefined } as PerformanceEntry,
    ]);
    expect(read()).toEqual([50, 1100, 2200, 'warm']);
    // Resource Timing can expose an already finished request on a later read.
    resources.mockReturnValue([fakeResource('content/rotunda.glb', 500, 40)]);
    expect(read()).toEqual([50, 500, 500, 'cold']);
    resources.mockReturnValue([]);
    expect(read()).toEqual([50, 0, 0, 'cold']);
    expect(resources).toHaveBeenCalledTimes(4);
  });

  it('assembles every field from the input, the marks module and the frame buffer', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('load.bin', 4000, 10),
      fakeResource('later.bin', 6000, 90),
      fakeResource('content/rotunda.glb', 5000, 20),
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
      gpu: { p50: 8.2, p95: 14.5, available: true },
      lookSwitchMs: 250,
      post: 'ao,traa',
      governor: 'level=ssgi-half;activity=cooldown;eligible=1;cooldown=4200;patience=0/2;qualify=3200/10000;p95=12.7;budget=16.7;threshold=13.36',
      governorLog:
        '[{"direction":"down","from":"full","to":"ssgi-half","p95Ms":19.4,"budgetMs":16.7,"atMs":1042.1,"reason":"p95 19.4 ms > 16.7 ms"}]',
    });
    expect(snap).toEqual({
      sceneFiles: null,
      loadMs: 50,
      payloadBytes: 9000,
      payloadNowBytes: 15000,
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
      gpu: { p50: 8.2, p95: 14.5, available: true },
      post: 'ao,traa',
      governor: 'level=ssgi-half;activity=cooldown;eligible=1;cooldown=4200;patience=0/2;qualify=3200/10000;p95=12.7;budget=16.7;threshold=13.36',
      governorLog:
        '[{"direction":"down","from":"full","to":"ssgi-half","p95Ms":19.4,"budgetMs":16.7,"atMs":1042.1,"reason":"p95 19.4 ms > 16.7 ms"}]',
      cacheState: 'cold',
    });
  });

  it('matrix 27: the governor fields bridge the committed canvas attributes into the snapshot', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
    marks.markFirstFrame(() => 50);
    const snap = marks.snapshot({
      info: { render: { drawCalls: 1, triangles: 2 } },
      backend: 'webgpu',
      tier: 'high',
      pixelRatio: 1,
      renderScale: 1,
      gpuName: 'Test GPU',
      frames: new FrameTimes(),
      gpu: { p50: null, p95: null, available: true },
      lookSwitchMs: null,
      post: 'ao,traa,ssgi,ssr',
      governor: 'level=no-ssgi;activity=recovery-qualifying;eligible=1;cooldown=0;patience=0/2;qualify=6800/10000;p95=10.2;budget=16.7;threshold=13.36',
      governorLog: '[]',
    });
    // The snapshot carries exactly what the composition root read off the canvas, so the panel
    // and the e2e suite see one committed source.
    expect(snap.governor).toContain('level=no-ssgi');
    expect(snap.governor).toContain('activity=recovery-qualifying');
    expect(snap.governor).toContain('threshold=13.36');
    expect(snap.governorLog).toBe('[]');
  });

  it('reads null loadMs before the mark and passes null lookSwitchMs and gpu', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
    const snap = marks.snapshot({
      info: { render: { drawCalls: 0, triangles: 0 } },
      backend: 'webgl2',
      tier: 'base',
      pixelRatio: 1.5,
      renderScale: 1,
      gpuName: 'SwiftShader',
      frames: new FrameTimes(),
      gpu: { p50: null, p95: null, available: false },
      lookSwitchMs: null,
      post: 'off',
    });
    expect(snap.loadMs).toBeNull();
    expect(snap.payloadBytes).toBe(0);
    expect(snap.payloadNowBytes).toBe(0);
    expect(snap.frameP50Ms).toBe(0);
    expect(snap.frameP95Ms).toBe(0);
    expect(snap.lookSwitchMs).toBeNull();
    expect(snap.gpu).toEqual({ p50: null, p95: null, available: false });
    expect(snap.post).toBe('off');
    expect(snap.cacheState).toBe('cold');
  });
});


describe('scene-files scope', () => {
  it.each(['full', 'half'] as const)('reads %s encoded body bytes for the opening look on cold and warm loads', async (set) => {
    const marks = await loadMarks();
    const prefix = set === 'half' ? '/content/half/' : '/content/';
    const opening = 'looks/zoot-suit.glb';
    const bodySizes = [5_000_000, 1_000_000, 2_000_000];
    for (const cold of [false, true]) {
      const entries = ['rotunda.glb', 'plinth.glb', opening].map((file, index) =>
        fakeResource(`http://localhost${prefix}${file}?v=1`, cold ? bodySizes[index] + 300 : 0,
          20, bodySizes[index]));
      entries.push(fakeResource(`http://localhost${prefix}looks/wallis-dress.glb`, 999, 60, 900));
      entries.push(fakeResource('http://localhost/content/thumbs/zoot-suit.jpg', 500, 10, 200));
      entries.push({ ...fakeResource(`http://localhost${prefix}looks/later.glb`, 999, 40, 900), startTime: 30 });
      expect(marks.sceneFilesPayload(entries, 50)).toEqual({
        bytes: 8_000_000,
        budgetBytes: set === 'half' ? 6_000_000 : 10_000_000,
      });
      expect(marks.sceneFilesPayload(entries, null)).toBeNull();
      expect(marks.sceneFilesPayload(entries.slice(1), 50)).toBeNull();
    }
  });

  it('uses encoded rather than decoded body bytes when responses are compressed', async () => {
    const marks = await loadMarks();
    const entries = ['rotunda.glb', 'plinth.glb', 'looks/opening.glb'].map((file) => ({
      ...fakeResource(`http://localhost/content/${file}`, 500, 20, 200), decodedBodySize: 1_000,
    }));
    expect(marks.sceneFilesPayload(entries, 50)).toEqual({ bytes: 600, budgetBytes: 10_000_000 });
  });
});
