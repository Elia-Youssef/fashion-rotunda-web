import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let imports = 0;
beforeEach(() => {
  vi.resetModules();
  imports = 0;
  vi.doMock('../../src/proof/runtime', () => {
    imports += 1;
    return {};
  });
});
afterEach(() => { vi.doUnmock('../../src/proof/runtime'); });

describe('proof loading', () => {
  it('does not import on production default or non-enabling proof values', async () => {
    const { loadProof } = await import('../../src/proof/load');
    for (const search of ['', '?proof=0', '?proof=true']) {
      expect(loadProof(search, false)).toBeNull();
    }
    expect(imports).toBe(0);
  });

  it.each([['?proof=1', false], ['', true]] as const)(
    'imports once for search=%s dev=%s', async (search, dev) => {
      const { loadProof } = await import('../../src/proof/load');
      const first = loadProof(search, dev);
      expect(first).not.toBeNull();
      expect(loadProof(search, dev)).toBe(first);
      await first;
      await loadProof(search, dev);
      expect(imports).toBe(1);
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

    // A failing vi.doMock factory surfaces as vitest's wrapped mocking error, so the assertion is
    // on the rejection reaching the caller; the original error rides along as its cause.
    await expect(loadProof('?proof=1', false)).rejects.toThrow();
    expect(imports).toBe(1);

    await loadProof('?proof=1', false);
    expect(imports).toBe(2);
  });

  it('a failed runtime import still rejects toward the startup failure path', async () => {
    vi.doMock('../../src/proof/runtime', async () => {
      imports += 1;
      throw new Error('chunk unavailable');
    });
    const { loadProof } = await import('../../src/proof/load');
    // main.ts awaits this promise outside its scene try, so the rejection reaches the page-level
    // startup failure routing rather than being swallowed by the proof loader.
    const ready = loadProof('?proof=1', false);
    await expect(ready).rejects.toThrow();
    expect(imports).toBe(1);
  });
});
