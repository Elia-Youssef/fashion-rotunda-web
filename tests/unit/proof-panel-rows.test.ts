// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mountProofPanel } from '../../src/proof/panel';
import type { ProofSnapshot } from '../../src/proof/marks';
import type { Page } from '@playwright/test';
import { nextProofReading } from '../e2e/support/preservation';
import { rowText, sampleSnapshot } from '../support/proof-panel';

// The mounted panel as a static table: the section markup and its units, row text and row
// identity across refreshes, the refresh intervals and the completion signal the preservation
// helper waits on, and the payload and GPU rows read straight from the snapshot.

describe('mountProofPanel', () => {
  it('captures canvas and rows on the completion signal, even when the rows are unchanged', async () => {
    const root = document.createElement('div');
    const canvas = document.createElement('canvas');
    canvas.id = 'scene';
    root.appendChild(canvas);
    document.body.appendChild(root);
    vi.stubGlobal('archvizCamera', { mode: 'orbit', orbit: { position: [1, 2, 3], target: [0, 0, 0] } });
    vi.stubGlobal('archvizE2E', { describeScene: () => ({ meshes: 5, materials: { marble: 2 } }) });
    let snap = sampleSnapshot();
    const handle = mountProofPanel(root, { read: () => snap, measure: async () => {}, intervalMs: 10_000 });
    // Execute the actual browser callback against jsdom; no browser or transport is started.
    const page = {
      evaluate: async (callback: (args: unknown) => unknown, args: unknown) => await callback(args),
    } as unknown as Page;
    try {
      let settled = false;
      const pending = nextProofReading(page).then(
        (reading) => { settled = true; return { reading, error: null }; },
        (error: unknown) => { settled = true; return { reading: null, error }; },
      );
      // A row mutation alone must not be mistaken for refresh completion.
      root.querySelector('dd')!.textContent = 'pending';
      canvas.width = 600;
      canvas.height = 400;
      canvas.dataset.frames = '10';
      await Promise.resolve();
      expect(settled).toBe(false);
      snap = { ...snap, drawCalls: 99, pixelRatio: 1, renderScale: 0.5 };
      handle.refresh();
      // Also lets a deliberately broken observer reach its rejection without a real wait.
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;
      expect(result.error).toBeNull();
      expect(result.reading).toMatchObject({
        canvas: { backing: { width: 600, height: 400 }, pixelRatio: 1, renderScale: 0.5, tier: 'high' },
        drawCalls: 99, frames: 10,
        camera: { mode: 'orbit', position: [1, 2, 3], target: [0, 0, 0] },
        scene: { meshes: 5, materials: { marble: 2 } },
      });
      const unchanged = nextProofReading(page).then(
        (reading) => ({ reading, error: null }),
        (error: unknown) => ({ reading: null, error }),
      );
      handle.refresh();
      await vi.advanceTimersByTimeAsync(5_000);
      const second = await unchanged;
      expect(second.error).toBeNull();
      expect(second.reading).toEqual(result.reading);
    } finally {
      handle.dispose();
      root.remove();
    }
  });

  it('publishes completion after every refresh, including unchanged rows, and stops on disposal', async () => {
    const root = document.createElement('div');
    let snap = sampleSnapshot();
    const handle = mountProofPanel(root, { read: () => snap, measure: async () => {}, intervalMs: 200 });
    const list = root.querySelector<HTMLElement>('.proof-panel__list')!;
    const nodes = Array.from(list.children);
    const initialText = list.textContent;
    const description = (name: string): string | null | undefined =>
      Array.from(list.querySelectorAll('dt')).find((term) => term.textContent === name)
        ?.nextElementSibling?.textContent;
    const completions: Array<{ count: string | undefined; calls: string | null | undefined }> = [];
    const observer = new MutationObserver(() => {
      completions.push({ count: list.dataset.refresh, calls: description('draw calls') });
    });
    observer.observe(list, { attributes: true, attributeFilter: ['data-refresh'] });
    expect(list.dataset.refresh).toBe('1');
    handle.refresh();
    await Promise.resolve();
    expect(list.dataset.refresh).toBe('2');
    expect(list.textContent).toBe(initialText);
    expect(Array.from(list.children)).toEqual(nodes);
    snap = { ...snap, drawCalls: 99 };
    handle.refresh();
    await Promise.resolve();
    vi.advanceTimersByTime(200);
    await Promise.resolve();
    expect(completions).toEqual([
      { count: '2', calls: '42 calls' },
      { count: '3', calls: '99 calls' },
      { count: '4', calls: '99 calls' },
    ]);
    handle.dispose();
    handle.refresh();
    vi.advanceTimersByTime(200);
    await Promise.resolve();
    expect(list.dataset.refresh).toBe('4');
    expect(completions).toHaveLength(3);
    observer.disconnect();
  });

  it('preserves complete row text and row identity across a fixed input sequence', async () => {
    const root = document.createElement('div');
    let snap = sampleSnapshot();
    snap.governor = 'off';
    snap.governorLog = '';
    const handle = mountProofPanel(root, { read: () => snap, measure: async () => {} });
    const dl = root.querySelector('dl')!;
    const mounted = Array.from(dl.children);
    const prefix = [
      'load', '1234.5 ms', 'scene files', '9.47 MB / 10.00 MB (inside)', 'all requests up to first frame', '3500 bytes', 'all requests so far', '9100 bytes',
      'draw calls', '42 calls', 'triangles', '123456 triangles', 'backend', 'webgpu',
      'tier', 'high', 'pixel ratio', '2.00', 'render scale', '1', 'gpu', 'NVIDIA GeForce RTX 4090',
      'frame work p50 (cpu)', '8.2 ms', 'frame work p95 (cpu)', '14.5 ms',
    ];
    const suffix = [
      'data-post', 'ao,traa', 'governor', 'off', 'governor log', 'no changes yet',
      'cache', 'cold', 'look switch', '250.0 ms', 'orbit', 'not measured',
    ];
    const assertRows = (gpuRows: string[], tail = suffix): void => {
      const expected = [...prefix, ...gpuRows, ...tail];
      expect(Array.from(dl.children, (node) => node.textContent)).toEqual(expected);
      expect(root.textContent).toBe(expected.join('') + 'Measure');
      for (const node of dl.children) expect(mounted.includes(node)).toBe(true);
    };
    assertRows(['gpu p50', '6.1 ms', 'gpu p95', '11.4 ms']);
    const mutations = new MutationObserver(() => {});
    mutations.observe(dl, { subtree: true, childList: true, characterData: true });
    handle.refresh();
    expect(mutations.takeRecords()).toEqual([]);
    expect(Array.from(dl.children)).toEqual(mounted);
    snap = { ...snap, payloadNowBytes: 10000 };
    handle.refresh();
    const changes = mutations.takeRecords();
    expect(changes).toHaveLength(1);
    expect(changes[0].target).toBe(mounted[7]);
    prefix[7] = '10000 bytes';
    assertRows(['gpu p50', '6.1 ms', 'gpu p95', '11.4 ms']);
    snap = { ...snap, gpu: { p50: null, p95: null, available: false } };
    handle.refresh();
    assertRows(['GPU', 'not exposed by this backend']);
    snap = { ...snap, gpu: { p50: null, p95: null, available: true } };
    handle.refresh();
    assertRows(['gpu p50', 'null', 'gpu p95', 'null']);
    expect(Array.from(dl.children)).toEqual(mounted);
    snap = { ...snap, payloadNowBytes: 12000, cacheState: 'warm', governorLog: 'broken' };
    handle.refresh();
    prefix[7] = '12000 bytes';
    suffix[5] = 'unreadable governor log';
    suffix[7] = 'warm';
    assertRows(['gpu p50', 'null', 'gpu p95', 'null']);
    root.querySelector<HTMLButtonElement>('button')!.click();
    await Promise.resolve();
    const measured = [...suffix];
    measured[11] = 'CPU p50: 8.2 ms, p95: 14.5 ms | GPU: no reading during the orbit | ' +
      'budget: 16.7 ms (inside)';
    assertRows(['gpu p50', 'null', 'gpu p95', 'null'], measured);
    mutations.disconnect();
    handle.dispose();
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
    expect(text).toContain('all requests up to first frame');
    expect(text).toContain('3500 bytes');
    expect(text).toContain('all requests so far');
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

  it('refreshes on the default interval when none is supplied', () => {
    const root = document.createElement('div');
    const read = vi.fn(sampleSnapshot);
    const handle = mountProofPanel(root, { read, measure: async () => {} });
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(499);
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(read).toHaveBeenCalledTimes(2);
    handle.dispose();
  });

  it('counts a scene payload exactly at its budget as inside', () => {
    const root = document.createElement('div');
    const handle = mountProofPanel(root, {
      read: () => ({ ...sampleSnapshot(), sceneFiles: { bytes: 8_000_000, budgetBytes: 8_000_000 } }),
      measure: async () => {},
    });
    expect(rowText(root, 'scene files')).toBe('8.00 MB / 8.00 MB (inside)');
    handle.dispose();
  });
});

it('keeps scene-file budgets separate from both browser request totals', () => {
  const root = document.createElement('div');
  let snap = sampleSnapshot();
  const handle = mountProofPanel(root, { read: () => snap, measure: async () => {} });
  const row = (term: string): string | null | undefined =>
    [...root.querySelectorAll('dt')].find((node) => node.textContent === term)?.nextElementSibling?.textContent;
  expect(row('scene files')).toBe('9.47 MB / 10.00 MB (inside)');
  expect(row('all requests up to first frame')).toBe('3500 bytes');
  expect(row('all requests so far')).toBe('9100 bytes');
  snap = { ...snap, sceneFiles: { bytes: 6_000_001, budgetBytes: 6_000_000 } };
  handle.refresh();
  expect(row('scene files')).toBe('6.00 MB / 6.00 MB (over)');
  snap = { ...snap, sceneFiles: null };
  handle.refresh();
  expect(row('scene files')).toBe('not available');
  handle.dispose();
});
