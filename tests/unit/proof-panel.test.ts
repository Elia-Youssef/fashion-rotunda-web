// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountProofPanel, overlayWanted } from '../../src/proof/panel';
import type { ProofSnapshot } from '../../src/proof/marks';
import { PROOF_POSITION, PROOF_TARGET, runProofOrbit } from '../../src/proof/orbit-run';

function sampleSnapshot(): ProofSnapshot {
  return {
    loadMs: 1234.5,
    payloadBytes: 3500,
    payloadNowBytes: 9100,
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('overlayWanted', () => {
  it('is true in dev or when ?proof=1 is in the search query', () => {
    expect(overlayWanted('?proof=1', false)).toBe(true);
    expect(overlayWanted('', false)).toBe(false);
    expect(overlayWanted('', true)).toBe(true);
    expect(overlayWanted('?proof=0', true)).toBe(true);
  });
});

describe('mountProofPanel', () => {
  it.each(['raf', 'timeout'] as const)('disposal retires the active %s orbit and retained button', async (kind) => {
    const pending = new Map<number, () => void>();
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', kind === 'raf' ? (cb: () => void) => {
      pending.set(++id, cb);
      return id;
    } : undefined);
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => { pending.delete(handle); });
    const root = document.createElement('div');
    const read = vi.fn(sampleSnapshot);
    const setPose = vi.fn();
    const onFrame = vi.fn();
    let clock = 0;
    const measure = vi.fn((signal: AbortSignal) => runProofOrbit({
      setPose, onFrame, proofPosition: PROOF_POSITION, proofTarget: PROOF_TARGET,
      durationMs: 100, now: () => clock, signal,
    }));
    const handle = mountProofPanel(root, { read, measure });
    const section = root.querySelector<HTMLElement>('.proof-panel')!;
    const button = root.querySelector<HTMLButtonElement>('.proof-panel__measure')!;
    button.click();
    expect(setPose).toHaveBeenCalledTimes(1);
    handle.dispose();
    const detachedText = section.textContent;
    const reads = read.mock.calls.length;
    clock = 100;
    for (const callback of [...pending.values()]) callback();
    await vi.advanceTimersByTimeAsync(100);
    expect(setPose).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(pending.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(read).toHaveBeenCalledTimes(reads);
    expect(section.textContent).toBe(detachedText);
    expect(button.disabled).toBe(true);
    button.disabled = false;
    button.click();
    handle.refresh();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(reads);
  });

  it.each(['before', 'after'] as const)('retained Measure is inert when disposed %s a completed run', async (stage) => {
    const root = document.createElement('div');
    const read = vi.fn(sampleSnapshot);
    const measure = vi.fn(async () => {});
    const handle = mountProofPanel(root, { read, measure });
    const button = root.querySelector<HTMLButtonElement>('.proof-panel__measure')!;
    if (stage === 'after') {
      button.click();
      await Promise.resolve();
      expect(button.disabled).toBe(false);
      expect(root.textContent).toContain('budget: 16.7 ms (inside)');
    }
    handle.dispose();
    const reads = read.mock.calls.length;
    button.click();
    handle.refresh();
    await Promise.resolve();
    expect(measure).toHaveBeenCalledTimes(stage === 'after' ? 1 : 0);
    expect(read).toHaveBeenCalledTimes(reads);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)('ignores a late measurement %s after disposal', async (outcome) => {
    const root = document.createElement('div');
    const read = vi.fn(sampleSnapshot);
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const handle = mountProofPanel(root, { read, measure: () => new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    }) });
    const section = root.querySelector<HTMLElement>('.proof-panel')!;
    const button = root.querySelector<HTMLButtonElement>('.proof-panel__measure')!;
    button.click();
    handle.dispose();
    const text = section.textContent;
    const reads = read.mock.calls.length;
    if (outcome === 'resolve') resolve();
    else reject(new Error('late failure'));
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(reads);
    expect(section.textContent).toBe(text);
    expect(button.disabled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('mounts section.proof-panel with definition list rows and units', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const read = vi.fn(sampleSnapshot);
    const measure = vi.fn(async () => {});

    const handle = mountProofPanel(root, { read, measure });
    const section = root.querySelector('section.proof-panel');
    expect(section).not.toBeNull();
    expect(section?.getAttribute('aria-label')).toBe('Proof');

    const text = section?.textContent ?? '';
    expect(text).toContain('load');
    expect(text).toContain('1234.5 ms');
    expect(text).toContain('payload');
    expect(text).toContain('3500 bytes');
    expect(text).toContain('payload now');
    expect(text).toContain('9100 bytes');
    expect(text).toContain('draw calls');
    expect(text).toContain('42 calls');
    expect(text).toContain('triangles');
    expect(text).toContain('123456 triangles');
    expect(text).toContain('webgpu');
    expect(text).toContain('high');
    expect(text).toContain('2.00');
    expect(text).toContain('gpu p50');
    expect(text).toContain('6.1 ms');
    expect(text).toContain('gpu p95');
    expect(text).toContain('11.4 ms');
    expect(text).toContain('data-post');
    expect(text).toContain('ao,traa');
    expect(text).toContain('governor');
    expect(text).toContain('level=ssgi-half');
    expect(text).toContain('activity=cooldown');
    expect(text).toContain('cooldown=4200');
    expect(text).toContain('p95=12.7');
    expect(text).toContain('budget=16.7');
    expect(text).toContain('threshold=13.36');
    expect(text).toContain('governor log');
    expect(text.indexOf('down full \u2192 ssgi-half')).toBeGreaterThan(-1);
    expect(text.indexOf('up no-ssgi \u2192 ssgi-half')).toBeGreaterThan(-1);
    expect(text).toContain('p95 19.4 ms > 16.7 ms');
    expect(text).toContain('p95 12.7 ms <= 13.36 ms after 10.0 s');
    expect(text).toContain('cache');
    expect(text).toContain('cold');
    expect(text).toContain('look switch');
    expect(text).toContain('250.0 ms');
    expect(text).toContain('orbit');
    expect(text).toContain('not measured');

    handle.dispose();
    root.remove();
  });

  // Matrix 27: the panel rows and the snapshot fields display the same committed governor
  // record, bridged through the canvas attributes the composition root publishes.
  it('renders the disabled governor and an empty log honestly', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const read = vi.fn((): ProofSnapshot => ({
      ...sampleSnapshot(),
      governor: 'off',
      governorLog: '',
    }));
    const handle = mountProofPanel(root, { read, measure: async () => {} });
    const text = root.querySelector('section.proof-panel')?.textContent ?? '';
    expect(text).toContain('off');
    expect(text).toContain('no changes yet');

    handle.dispose();
    root.remove();
  });

  it('renders an unreadable log as unreadable rather than inventing entries', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const read = vi.fn((): ProofSnapshot => ({
      ...sampleSnapshot(),
      governorLog: 'not json',
    }));
    const handle = mountProofPanel(root, { read, measure: async () => {} });
    const text = root.querySelector('section.proof-panel')?.textContent ?? '';
    expect(text).toContain('unreadable governor log');

    handle.dispose();
    root.remove();
  });

  it('prints "not exposed by this backend" when the GPU series never read a value', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const read = vi.fn((): ProofSnapshot => ({
      ...sampleSnapshot(),
      gpu: { p50: null, p95: null, available: false },
    }));
    const measure = vi.fn(async () => {});

    const handle = mountProofPanel(root, { read, measure });
    const text = root.querySelector('section.proof-panel')?.textContent ?? '';
    expect(text).toContain('GPU');
    expect(text).toContain('not exposed by this backend');

    handle.dispose();
    root.remove();
  });

  // available, not the nulls: a window emptied at the start of a Measure run also reads null on
  // both percentiles, and that backend does expose GPU time.
  it('keeps the gpu rows when the series is available but momentarily empty', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const read = vi.fn((): ProofSnapshot => ({
      ...sampleSnapshot(),
      gpu: { p50: null, p95: null, available: true },
    }));

    const handle = mountProofPanel(root, { read, measure: async () => {} });
    const text = root.querySelector('section.proof-panel')?.textContent ?? '';
    expect(text).not.toContain('not exposed by this backend');
    expect(text).toContain('gpu p50');
    expect(text).toContain('null');

    handle.dispose();
    root.remove();
  });

  it('disables the Measure button while running and displays orbit results', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const read = vi.fn(sampleSnapshot);

    let resolveMeasure: () => void = () => {};
    const measure = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveMeasure = resolve;
        }),
    );

    const handle = mountProofPanel(root, { read, measure });
    const button = root.querySelector<HTMLButtonElement>('button.proof-panel__measure');
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(false);

    button?.click();
    expect(button?.disabled).toBe(true);
    expect(root.querySelector('.proof-panel__status')?.textContent).toBe('measuring...');

    resolveMeasure();
    await vi.waitFor(() => expect(button?.disabled).toBe(false));
    expect(root.querySelector('.proof-panel__status')?.textContent).toBe('');

    const text = root.querySelector('section.proof-panel')?.textContent ?? '';
    expect(text).toContain('budget: 16.7 ms (inside)');
    expect(text).toContain('CPU p50: 8.2 ms, p95: 14.5 ms');

    handle.dispose();
    root.remove();
  });

  it('displays error status when measure rejects and re-enables button', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const read = vi.fn(sampleSnapshot);
    const measure = vi.fn(async () => {
      throw new Error('camera not mounted yet');
    });

    const handle = mountProofPanel(root, { read, measure });
    const button = root.querySelector<HTMLButtonElement>('button.proof-panel__measure');
    button?.click();

    await vi.waitFor(() => expect(button?.disabled).toBe(false));
    expect(root.querySelector('.proof-panel__status')?.textContent).toBe('camera not mounted yet');

    handle.dispose();
    root.remove();
  });

  it('refreshes at the specified interval and disposes cleanly', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const read = vi.fn(sampleSnapshot);
    const handle = mountProofPanel(root, { read, measure: async () => {}, intervalMs: 200 });

    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(read).toHaveBeenCalledTimes(2);

    handle.dispose();
    expect(root.querySelector('section.proof-panel')).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(read).toHaveBeenCalledTimes(2);

    root.remove();
  });
});
