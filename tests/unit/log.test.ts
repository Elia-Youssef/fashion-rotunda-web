// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { diagnosticsWanted, info } from '../../src/log';

// The gate that keeps a visitor's console quiet: only a dev session, ?proof=1 or ?e2e=1 hears
// the routine [archviz] info lines. jsdom provides the location the live gate reads, and
// vi.stubEnv drives the import.meta.env.DEV branch both ways.

function setSearch(search: string): void {
  window.history.replaceState(null, '', search === '' ? '/' : `/${search}`);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSearch('');
});

describe('diagnosticsWanted', () => {
  it('hears a dev session whatever the url says', () => {
    expect(diagnosticsWanted('', true)).toBe(true);
    expect(diagnosticsWanted('?look=mondrian', true)).toBe(true);
  });

  it('hears the proof and e2e parameters in their exact on spelling', () => {
    expect(diagnosticsWanted('?proof=1', false)).toBe(true);
    expect(diagnosticsWanted('?e2e=1', false)).toBe(true);
    expect(diagnosticsWanted('?proof=1&e2e=1', false)).toBe(true);
    expect(diagnosticsWanted('?e2e=1&tier=high', false)).toBe(true);
  });

  it('hears nothing for a bare visitor url or an off spelling', () => {
    expect(diagnosticsWanted('', false)).toBe(false);
    expect(diagnosticsWanted('?proof=0', false)).toBe(false);
    expect(diagnosticsWanted('?e2e=0', false)).toBe(false);
    expect(diagnosticsWanted('?webgl=1&gate=off', false)).toBe(false);
    expect(diagnosticsWanted('?look=mondrian&variant=dark', false)).toBe(false);
  });
});

describe('info', () => {
  it('prints for a dev session', () => {
    vi.stubEnv('DEV', true);
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    info('[archviz] tier: high');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('[archviz] tier: high');
  });

  it('prints with its extra arguments when the session asked for proof or e2e', () => {
    vi.stubEnv('DEV', false);
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    setSearch('?proof=1');
    info('[archviz] renderer backend: webgpu');
    setSearch('?e2e=1');
    info('[archviz] tier: mid', { reason: 'benchmark' });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, '[archviz] renderer backend: webgpu');
    expect(spy).toHaveBeenNthCalledWith(2, '[archviz] tier: mid', { reason: 'benchmark' });
  });

  it('is silent for a visitor in a production build', () => {
    vi.stubEnv('DEV', false);
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    setSearch('');
    info('[archviz] renderer backend: webgl2');
    setSearch('?proof=0&e2e=0');
    info('[archviz] benchmark p95: 9.5 ms');
    expect(spy).not.toHaveBeenCalled();
  });

  it('counts a process with no location as asking for nothing', () => {
    // A process without a location binding has no URL to ask through: the gate reads an
    // empty search. stubGlobal stands in for that process inside the jsdom environment.
    vi.stubEnv('DEV', false);
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.stubGlobal('location', undefined);
    info('[archviz] renderer backend: webgpu');
    expect(spy).not.toHaveBeenCalled();
  });

  it('counts the test process as a dev session, so modules under test log normally', () => {
    // No env stub: vitest runs with MODE=test, where import.meta.env.DEV is true. The governor
    // unit tests rely on that to see the routed info lines through their console.info spy.
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    info('[archviz] post governor recovered to full');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
