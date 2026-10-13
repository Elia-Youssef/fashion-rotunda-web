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
});
