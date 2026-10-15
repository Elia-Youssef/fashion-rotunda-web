import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseLook, chooseVariant, loadContentSet, switchOrder } from '../../src/catalog/bootstrap';
import type { Catalog, CatalogLook } from '../../src/catalog/catalog';

const { loadCatalog } = vi.hoisted(() => ({ loadCatalog: vi.fn() }));
vi.mock('../../src/catalog/catalog', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/catalog/catalog')>(), loadCatalog,
}));

function look(id: string): CatalogLook {
  return { id, name: id, description: id, thumbnail: null, file: `${id}.glb`,
    variants: ['base', 'light'], defaultVariant: 'base', mannequinNode: 'mannequin' };
}
const catalog: Catalog = {
  version: 1, environment: { file: 'sky.hdr' }, rotunda: { file: 'room.glb' },
  plinth: { file: 'plinth.glb' }, looks: [look('first'), look('second')], views: {},
};

afterEach(() => { vi.restoreAllMocks(); loadCatalog.mockReset(); });

describe('catalog bootstrap', () => {
  it('loads only the requested full or half catalogue', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadCatalog.mockResolvedValue(catalog);
    expect(await loadContentSet(false)).toEqual({ base: '/content', catalog });
    expect(loadCatalog.mock.calls).toEqual([['/content/catalog.json']]);
    loadCatalog.mockClear();
    expect(await loadContentSet(true)).toEqual({ base: '/content/half', catalog });
    expect(loadCatalog.mock.calls).toEqual([['/content/half/catalog.json']]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns before falling back from half to full and propagates full failure', async () => {
    const sequence: string[] = [];
    const halfError = new Error('missing half');
    const fullError = new Error('missing full');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { sequence.push('warn'); });
    loadCatalog.mockImplementation(async (url: string) => {
      sequence.push(url);
      if (url === '/content/half/catalog.json') throw halfError;
      return catalog;
    });
    expect(await loadContentSet(true)).toEqual({ base: '/content', catalog });
    expect(sequence).toEqual(['/content/half/catalog.json', 'warn', '/content/catalog.json']);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[archviz] no content set at /content/half, using /content', halfError,
    );
    loadCatalog.mockRejectedValue(fullError);
    await expect(loadContentSet(false)).rejects.toBe(fullError);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('selects the requested look or first look with the original warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(chooseLook(catalog, new URLSearchParams())).toBe(catalog.looks[0]);
    expect(chooseLook(catalog, new URLSearchParams('look=second'))).toBe(catalog.looks[1]);
    expect(warn).not.toHaveBeenCalled();
    expect(chooseLook(catalog, new URLSearchParams('look=missing'))).toBe(catalog.looks[0]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[archviz] no look "missing" in the catalogue, showing "first"',
    );
  });

  it('selects a requested variant or its default with the original warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = catalog.looks[0];
    expect(chooseVariant(first, new URLSearchParams())).toBe('base');
    expect(chooseVariant(first, new URLSearchParams('variant=light'))).toBe('light');
    expect(warn).not.toHaveBeenCalled();
    expect(chooseVariant(first, new URLSearchParams('variant=missing'))).toBe('base');
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      '[archviz] the look "first" has no variant "missing", showing "base"',
    );
  });

  it('cycles other looks and returns to the initial look for memory comparisons', () => {
    expect(switchOrder(['a', 'b', 'c'], 'b', 5)).toEqual(['a', 'c', 'a', 'c', 'b']);
    expect(switchOrder(['a', 'b'], 'a', 1)).toEqual(['a']);
    expect(switchOrder(['a', 'b'], 'a', 0)).toEqual([]);
    expect(switchOrder(['a'], 'a', 5)).toEqual([]);
  });
});
