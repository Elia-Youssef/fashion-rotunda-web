// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountOverlay, overlayWanted } from '../../src/proof/overlay';
import type { ProofSnapshot } from '../../src/proof/marks';

function sampleSnapshot(): ProofSnapshot {
  return {
    loadMs: 1234,
    payloadBytes: 3500,
    payloadNowBytes: 9100,
    drawCalls: 42,
    triangles: 123456,
    backend: 'webgpu',
    tier: 'mid',
    pixelRatio: 2,
    renderScale: 0.85,
    gpuName: 'Intel(R) UHD Graphics',
    frameP50Ms: 8.2,
    frameP95Ms: 16.7,
    lookSwitchMs: 250,
    gpu: { p50: 7.0, p95: 12.0, available: true },
    post: 'off',
    cacheState: 'cold',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('overlayWanted', () => {
  it('is true for ?proof=1, false without it, and true in dev regardless', () => {
    expect(overlayWanted('?proof=1', false)).toBe(true);
    expect(overlayWanted('', false)).toBe(false);
    expect(overlayWanted('', true)).toBe(true);
    expect(overlayWanted('?proof=0', false)).toBe(false);
    expect(overlayWanted('?proof=0', true)).toBe(true);
  });
});

describe('mountOverlay', () => {
  it('mounts a pre.proof-overlay showing every snapshot field with its unit', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const read = vi.fn(sampleSnapshot);
    const handle = mountOverlay(root, read);
    const pre = root.querySelector('pre.proof-overlay');
    expect(pre).not.toBeNull();
    const text = pre?.textContent ?? '';
    expect(text).toContain('load: 1234.0 ms');
    expect(text).toContain('payload: 3500 bytes');
    expect(text).toContain('draw calls: 42 calls');
    expect(text).toContain('triangles: 123456 triangles');
    expect(text).toContain('backend: webgpu');
    expect(text).toContain('tier: mid');
    expect(text).toContain('pixel ratio: 2.00');
    expect(text).toContain('render scale: 0.85');
    expect(text).toContain('gpu: Intel(R) UHD Graphics');
    expect(text).toContain('frame p50: 8.2 ms');
    expect(text).toContain('frame p95: 16.7 ms');
    expect(text).toContain('look switch: 250.0 ms');
    handle.dispose();
    root.remove();
  });

  it('renders null fields as null text', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const read = vi.fn((): ProofSnapshot => ({
      ...sampleSnapshot(),
      loadMs: null,
      lookSwitchMs: null,
    }));
    const handle = mountOverlay(root, read);
    const text = root.querySelector('pre.proof-overlay')?.textContent ?? '';
    expect(text).toContain('load: null');
    expect(text).toContain('look switch: null');
    handle.dispose();
    root.remove();
  });

  it('refreshes every intervalMs, 500 by default', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const read = vi.fn(sampleSnapshot);
    const handle = mountOverlay(root, read);
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(499);
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(read).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(read).toHaveBeenCalledTimes(4);
    handle.dispose();
    root.remove();
  });

  it('honours a custom intervalMs', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const read = vi.fn(sampleSnapshot);
    const handle = mountOverlay(root, read, { intervalMs: 100 });
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    expect(read).toHaveBeenCalledTimes(2);
    handle.dispose();
    root.remove();
  });

  it('dispose removes the element and stops the timer', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const read = vi.fn(sampleSnapshot);
    const handle = mountOverlay(root, read);
    expect(root.querySelectorAll('pre.proof-overlay').length).toBe(1);
    handle.dispose();
    expect(root.querySelectorAll('pre.proof-overlay').length).toBe(0);
    const readsAtDispose = read.mock.calls.length;
    vi.advanceTimersByTime(5000);
    expect(read.mock.calls.length).toBe(readsAtDispose);
    root.remove();
  });

  it('mounts nothing and installs no timer when root is null', () => {
    const read = vi.fn(sampleSnapshot);
    const handle = mountOverlay(null, read);
    expect(read).not.toHaveBeenCalled();
    handle.dispose();
    vi.advanceTimersByTime(5000);
    expect(read).not.toHaveBeenCalled();
    expect(document.querySelectorAll('pre.proof-overlay').length).toBe(0);
  });
});
