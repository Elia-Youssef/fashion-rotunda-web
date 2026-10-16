import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let imports = 0;
beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  imports = 0;
  vi.doMock('../../src/proof/runtime', () => {
    imports += 1;
    return {};
  });
});
afterEach(() => {
  vi.doUnmock('../../src/proof/runtime');
  vi.doUnmock('../../src/ui/lazy-import');
  vi.restoreAllMocks();
});

describe('proof loading', () => {
  it('does not import on production default or non-enabling proof values', async () => {
    const { loadProof } = await import('../../src/proof/load');
    for (const search of ['', '?proof=0', '?proof=true']) {
      expect(await loadProof(search, false)).toBeNull();
    }
    expect(imports).toBe(0);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([['?proof=1', false], ['', true]] as const)(
    'imports once for search=%s dev=%s', async (search, dev) => {
      const { loadProof } = await import('../../src/proof/load');
      const first = loadProof(search, dev);
      const concurrent = loadProof(search, dev);
      const tools = await first;
      expect(tools).toBe(await import('../../src/proof/runtime'));
      expect(await concurrent).toBe(tools);
      expect(await loadProof(search, dev)).toBe(tools);
      expect(imports).toBe(1);
      expect(console.warn).not.toHaveBeenCalled();
    },
  );

  it('forgets a failed runtime import, so a later proof request retries it', async () => {
    let failNext = true;
    vi.doMock('../../src/proof/runtime', async () => {
      imports += 1;
      if (failNext) {
        failNext = false;
        throw new Error('chunk unavailable');
      }
      return {};
    });
    const { loadProof } = await import('../../src/proof/load');

    expect(await loadProof('?proof=1', false)).toBeNull();
    expect(imports).toBe(1);
    expect(console.warn).toHaveBeenCalledTimes(1);

    expect(await loadProof('?proof=1', false)).not.toBeNull();
    expect(imports).toBe(2);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('chunk unavailable'), 'offline', null])(
    'disables proof and warns once with the rejected cause %s', async (cause) => {
      // Isolate the startup decision from module-mock errors that wrap the original rejection.
      vi.doMock('../../src/ui/lazy-import', () => ({
        lazyImport: () => () => Promise.reject(cause),
      }));
      const { loadProof } = await import('../../src/proof/load');
      expect(await loadProof('?proof=1', false)).toBeNull();
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(
        '[archviz] proof overlay unavailable:', cause instanceof Error ? cause.message : String(cause),
      );
    },
  );
});
