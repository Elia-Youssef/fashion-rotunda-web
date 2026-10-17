// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { mountProofPanel } from '../../src/proof/panel';
import type { ProofSnapshot } from '../../src/proof/marks';
import { PROOF_POSITION, PROOF_TARGET, runProofOrbit } from '../../src/proof/orbit-run';
import { rowText, sampleSnapshot } from '../support/proof-panel';

// The Measure control and its orbit runs: the button's states and pending guard, the polite
// status region, the orbit row's formatting and budget grading, and the retirement of runs and
// buttons at disposal.

describe('mountProofPanel', () => {
  it('formats a held orbit only when measurement values change', async () => {
    const root = document.createElement('div');
    let snap = { ...sampleSnapshot(), frameP50Ms: 77.7 };
    const fixed = vi.spyOn(Number.prototype, 'toFixed');
    const handle = mountProofPanel(root, { read: () => snap, measure: async () => {} });
    const button = root.querySelector<HTMLButtonElement>('button')!;
    button.click();
    await Promise.resolve();
    snap = sampleSnapshot();
    fixed.mockClear();
    handle.refresh();
    handle.refresh();
    expect(root.textContent).toContain('CPU p50: 77.7 ms');
    expect(fixed.mock.contexts.map(Number)).not.toContain(77.7);
    snap = { ...snap, frameP50Ms: 77.7 };
    fixed.mockClear();
    button.click();
    await Promise.resolve();
    // The live row formats once; the equal held measurement does not format a second time.
    expect(fixed.mock.contexts.map(Number).filter((n) => n === 77.7)).toHaveLength(1);
    snap = { ...snap, frameP50Ms: 88.8 };
    button.click();
    await Promise.resolve();
    expect(root.textContent).toContain('CPU p50: 88.8 ms');
    handle.dispose();
  });

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

  it('marks the measuring status as the only polite live region, excluding the button', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let resolveMeasure: () => void = () => {};
    const measure = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveMeasure = resolve;
        }),
    );

    const handle = mountProofPanel(root, { read: vi.fn(sampleSnapshot), measure });
    const status = root.querySelector<HTMLElement>('.proof-panel__status')!;
    // Exactly one live region, the status span itself: a region on the actions row would also
    // announce the static Measure label, and one on the section the whole table.
    expect(root.querySelectorAll('[aria-live], [role="status"]')).toHaveLength(1);
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    const button = root.querySelector<HTMLButtonElement>('button.proof-panel__measure')!;
    expect(status.contains(button)).toBe(false);
    expect(status.textContent).not.toContain('Measure');

    button.click();
    expect(status.textContent).toBe('measuring...');
    resolveMeasure();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(status.textContent).toBe('');

    handle.dispose();
    root.remove();
  });

  it('announces a failed measurement through the same polite status region', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const measure = vi.fn(async () => {
      throw new Error('camera not mounted yet');
    });

    const handle = mountProofPanel(root, { read: vi.fn(sampleSnapshot), measure });
    const status = root.querySelector<HTMLElement>('.proof-panel__status')!;
    const button = root.querySelector<HTMLButtonElement>('button.proof-panel__measure')!;
    button.click();

    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('camera not mounted yet');

    handle.dispose();
    root.remove();
  });

  it('prints the orbit frame budget of the snapshot tier, Mid for an unknown tier', async () => {
    const root = document.createElement('div');
    let tier = 'high';
    const read = (): ProofSnapshot => ({ ...sampleSnapshot(), tier, frameP95Ms: 10 });
    const handle = mountProofPanel(root, { read, measure: async () => {}, intervalMs: 10_000 });
    const button = root.querySelector<HTMLButtonElement>('button')!;
    const measureAgain = async (): Promise<void> => {
      button.click();
      await Promise.resolve();
    };
    await measureAgain();
    expect(rowText(root, 'orbit')).toContain('budget: 16.7 ms (inside)');
    tier = 'base';
    await measureAgain();
    expect(rowText(root, 'orbit')).toContain('budget: 24.0 ms (inside)');
    tier = 'mid';
    await measureAgain();
    expect(rowText(root, 'orbit')).toContain('budget: 20.0 ms (inside)');
    // A tier string outside the table must not invent a budget: Mid is the panel's answer.
    tier = 'ultra';
    await measureAgain();
    expect(rowText(root, 'orbit')).toContain('budget: 20.0 ms (inside)');
    handle.dispose();
  });

  it('prints the orbit GPU percentiles when read and the backend answer when not exposed', async () => {
    const root = document.createElement('div');
    let snap: ProofSnapshot = sampleSnapshot();
    const handle = mountProofPanel(root, { read: () => snap, measure: async () => {}, intervalMs: 10_000 });
    const button = root.querySelector<HTMLButtonElement>('button')!;
    button.click();
    await Promise.resolve();
    expect(rowText(root, 'orbit')).toContain('GPU p50: 6.1 ms, p95: 11.4 ms');
    snap = { ...snap, gpu: { p50: null, p95: null, available: false } };
    button.click();
    await Promise.resolve();
    expect(rowText(root, 'orbit')).toContain('GPU: not exposed by this backend');
    handle.dispose();
  });

  it('ignores further Measure clicks while a run is pending', async () => {
    const root = document.createElement('div');
    let resolveMeasure!: () => void;
    const measure = vi.fn(() => new Promise<void>((resolve) => { resolveMeasure = resolve; }));
    const handle = mountProofPanel(root, { read: vi.fn(sampleSnapshot), measure, intervalMs: 10_000 });
    const button = root.querySelector<HTMLButtonElement>('button')!;
    button.click();
    // A click event that reaches the listener directly skips the platform's disabled-button
    // filter, so the panel's own pending guard is the only defense left.
    button.dispatchEvent(new MouseEvent('click'));
    button.dispatchEvent(new MouseEvent('click'));
    expect(measure).toHaveBeenCalledTimes(1);
    resolveMeasure();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    button.click();
    await Promise.resolve();
    expect(measure).toHaveBeenCalledTimes(2);
    handle.dispose();
  });

  it('grades the orbit p95 at and over the tier budget', async () => {
    const root = document.createElement('div');
    let snap: ProofSnapshot = { ...sampleSnapshot(), frameP95Ms: 16.7 };
    const handle = mountProofPanel(root, { read: () => snap, measure: async () => {}, intervalMs: 10_000 });
    const button = root.querySelector<HTMLButtonElement>('button')!;
    button.click();
    await Promise.resolve();
    // Exactly at the High budget counts as inside.
    expect(rowText(root, 'orbit')).toContain('budget: 16.7 ms (inside)');
    snap = { ...snap, frameP95Ms: 30 };
    button.click();
    await Promise.resolve();
    expect(rowText(root, 'orbit')).toContain('budget: 16.7 ms (over)');
    handle.dispose();
  });

  it('reformats the orbit row whenever any measured field changes', async () => {
    const root = document.createElement('div');
    let snap: ProofSnapshot = sampleSnapshot();
    const handle = mountProofPanel(root, { read: () => snap, measure: async () => {}, intervalMs: 10_000 });
    const button = root.querySelector<HTMLButtonElement>('button')!;
    const measureAgain = async (): Promise<string> => {
      button.click();
      await Promise.resolve();
      return rowText(root, 'orbit') ?? '';
    };
    expect(await measureAgain()).toContain('CPU p50: 8.2 ms, p95: 14.5 ms');
    snap = { ...snap, frameP95Ms: 15.5 };
    expect(await measureAgain()).toContain('CPU p50: 8.2 ms, p95: 15.5 ms');
    snap = { ...snap, gpu: { p50: 7.7, p95: 11.4, available: true } };
    expect(await measureAgain()).toContain('GPU p50: 7.7 ms, p95: 11.4 ms');
    snap = { ...snap, gpu: { p50: 7.7, p95: 13.3, available: true } };
    expect(await measureAgain()).toContain('GPU p50: 7.7 ms, p95: 13.3 ms');
    snap = { ...snap, gpu: { p50: 7.7, p95: 13.3, available: false } };
    expect(await measureAgain()).toContain('GPU: not exposed by this backend');
    snap = { ...snap, tier: 'base' };
    expect(await measureAgain()).toContain('budget: 24.0 ms (inside)');
    handle.dispose();
  });

  it('reports a rejection that is not an Error as a failed measurement', async () => {
    const root = document.createElement('div');
    const rejection: unknown = { message: 'orbit cancelled' };
    const measure = vi.fn(() => Promise.reject(rejection));
    const handle = mountProofPanel(root, { read: vi.fn(sampleSnapshot), measure, intervalMs: 10_000 });
    const button = root.querySelector<HTMLButtonElement>('button')!;
    button.click();
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    expect(root.querySelector('.proof-panel__status')?.textContent).toBe('measure failed');
    handle.dispose();
  });

  it('renders the Measure control as a plain type=button button', () => {
    const root = document.createElement('div');
    const handle = mountProofPanel(root, { read: vi.fn(sampleSnapshot), measure: async () => {} });
    expect(root.querySelector<HTMLButtonElement>('button')!.type).toBe('button');
    handle.dispose();
  });
});
