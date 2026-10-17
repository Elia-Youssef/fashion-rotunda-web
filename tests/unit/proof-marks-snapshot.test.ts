// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { fakeResource, loadMarks } from '../support/proof-marks';
import { FrameTimes } from '../../src/proof/frametime';

// The composite proof record: every field snapshot() assembles from the marks module, the
// frame buffer and the committed canvas attributes.

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

  it('reports a zero load payload before the mark even with resources already listed', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('content/rotunda.glb', 5000, 20),
    ]);
    const snap = marks.snapshot({
      info: { render: { drawCalls: 1, triangles: 2 } }, backend: 'webgpu', tier: 'high',
      pixelRatio: 1, renderScale: 1, gpuName: 'Test GPU', frames: new FrameTimes(),
      gpu: { p50: null, p95: null, available: false }, lookSwitchMs: null, post: 'off',
    });
    // The load payload pairs with loadMs: with no first frame yet there is no load to sum,
    // while the running total still shows every byte seen so far.
    expect(snap.loadMs).toBeNull();
    expect(snap.payloadBytes).toBe(0);
    expect(snap.payloadNowBytes).toBe(5000);
  });

  it('carries the scene files payload computed from the current buffer', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('http://localhost/content/rotunda.glb', 500, 40, 5_000_000),
      fakeResource('http://localhost/content/plinth.glb', 300, 45, 1_000_000),
      fakeResource('http://localhost/content/looks/opening.glb', 200, 50, 2_000_000),
      fakeResource('http://localhost/content/looks/later.glb', 999, 90, 900),
    ]);
    marks.markFirstFrame(() => 50);
    const snap = marks.snapshot({
      info: { render: { drawCalls: 1, triangles: 2 } }, backend: 'webgpu', tier: 'high',
      pixelRatio: 1, renderScale: 1, gpuName: 'Test GPU', frames: new FrameTimes(),
      gpu: { p50: null, p95: null, available: false }, lookSwitchMs: null, post: 'off',
    });
    expect(snap.sceneFiles).toEqual({ bytes: 8_000_000, budgetBytes: 10_000_000 });
  });

  it('defaults the governor fields when the input carries none', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
    marks.markFirstFrame(() => 50);
    const snap = marks.snapshot({
      info: { render: { drawCalls: 1, triangles: 2 } }, backend: 'webgpu', tier: 'high',
      pixelRatio: 1, renderScale: 1, gpuName: 'Test GPU', frames: new FrameTimes(),
      gpu: { p50: null, p95: null, available: false }, lookSwitchMs: null, post: 'off',
    });
    expect(snap.governor).toBe('off');
    expect(snap.governorLog).toBe('');
  });

  it('honours an explicit cacheState over the state derived from resources', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('content/rotunda.glb', 12345, 100),
    ]);
    marks.markFirstFrame(() => 50);
    const snap = marks.snapshot({
      info: { render: { drawCalls: 1, triangles: 2 } }, backend: 'webgpu', tier: 'high',
      pixelRatio: 1, renderScale: 1, gpuName: 'Test GPU', frames: new FrameTimes(),
      gpu: { p50: null, p95: null, available: false }, lookSwitchMs: null, post: 'off',
      cacheState: 'warm',
    });
    // The composition root observed the load itself; its answer outranks a fresh read of the
    // timing buffer, which can no longer see the cold transfer.
    expect(snap.cacheState).toBe('warm');
  });
});
