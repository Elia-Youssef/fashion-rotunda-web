import { afterEach, beforeEach, vi } from 'vitest';

import type { ProofSnapshot } from '../../src/proof/marks';

// The proof-panel harness shared by the proof-panel suites: the sample snapshot every row
// expectation is written against, the dt/dd row lookup, and the fake-timer setup the panel's
// refresh and orbit sequencing needs. The hooks register when this module loads, so every suite
// that imports the harness runs them, and Vitest's per-file isolation keeps them per suite.

export function sampleSnapshot(): ProofSnapshot {
  return {
    loadMs: 1234.5,
    payloadBytes: 3500,
    payloadNowBytes: 9100,
    sceneFiles: { bytes: 9_471_968, budgetBytes: 10_000_000 },
    drawCalls: 42,
    triangles: 123456,
    backend: 'webgpu',
    tier: 'high',
    pixelRatio: 2,
    renderScale: 1.0,
    gpuName: 'NVIDIA GeForce RTX 4090',
    frameP50Ms: 8.2,
    frameP95Ms: 14.5,
    lookSwitchMs: 250.0,
    gpu: { p50: 6.1, p95: 11.4, available: true },
    post: 'ao,traa',
    governor: 'level=ssgi-half;activity=cooldown;eligible=1;cooldown=4200;patience=0/2;qualify=3200/10000;p95=12.7;budget=16.7;threshold=13.36',
    governorLog:
      '[{"direction":"down","from":"full","to":"ssgi-half","p95Ms":19.4,"budgetMs":16.7,"atMs":1042.1,"reason":"p95 19.4 ms > 16.7 ms"},' +
      '{"direction":"up","from":"no-ssgi","to":"ssgi-half","p95Ms":12.7,"budgetMs":16.7,"atMs":22104.3,"reason":"p95 12.7 ms <= 13.36 ms after 10.0 s"}]',
    cacheState: 'cold',
  };
}

export function rowText(root: HTMLElement, term: string): string | null {
  const dt = [...root.querySelectorAll('dt')].find((node) => node.textContent === term);
  return dt?.nextElementSibling?.textContent ?? null;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
