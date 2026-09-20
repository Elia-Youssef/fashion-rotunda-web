import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, contentUrl, loadCatalog, parseCatalog } from '../../src/catalog/catalog';

// The fixtures are built as plain JSON so a test can delete or corrupt one field and leave the rest
// of the document valid, which is what parseCatalog has to answer for.

function lookJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'wallis-dress',
    name: 'Wallis Dress',
    description: 'In 1937, Wallis Simpson married Prince Edward of Great Britain.',
    thumbnail: 'thumbs/wallis-dress.png',
    file: 'looks/wallis-dress.glb',
    audio: null,
    variants: ['base', 'light', 'dark'],
    defaultVariant: 'base',
    mannequinNode: 'mannequin',
    ...overrides,
  };
}

function catalogJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: CATALOG_VERSION,
    environment: { file: 'env/school-field-cloudy-1k.hdr' },
    rotunda: { file: 'rotunda.glb' },
    plinth: { file: 'plinth.glb' },
    looks: [lookJson()],
    views: { proof: { position: [0, 1.7, 4.2], target: [0, 1, 0], fov: 40 } },
    ...overrides,
  };
}

describe('parseCatalog', () => {
  it('reads the shape the optimize pass writes', () => {
    const catalog = parseCatalog(catalogJson());
    expect(catalog.version).toBe(CATALOG_VERSION);
    expect(catalog.environment.file).toBe('env/school-field-cloudy-1k.hdr');
    expect(catalog.rotunda.file).toBe('rotunda.glb');
    expect(catalog.plinth.file).toBe('plinth.glb');
    expect(catalog.looks).toHaveLength(1);
    expect(catalog.looks[0].id).toBe('wallis-dress');
    expect(catalog.looks[0].variants).toEqual(['base', 'light', 'dark']);
    expect(catalog.looks[0].mannequinNode).toBe('mannequin');
    expect(catalog.views['proof'].position).toEqual([0, 1.7, 4.2]);
    expect(catalog.views['proof'].fov).toBe(40);
  });

  it('keeps a null thumbnail and a null audio reference', () => {
    const catalog = parseCatalog(catalogJson({ looks: [lookJson({ thumbnail: null })] }));
    expect(catalog.looks[0].thumbnail).toBeNull();
    expect(catalog.looks[0].audio).toBeNull();
  });

  it('ignores fields it does not read, so the optimize pass can add its own', () => {
    const catalog = parseCatalog(
      catalogJson({ looks: [lookJson({ garmentNodes: ['garment', 'garment-1'] })], notes: 'hello' }),
    );
    expect(catalog.looks[0].id).toBe('wallis-dress');
  });

  const brokenDocuments: [string, Record<string, unknown>, string][] = [
    ['a missing look field', { looks: [lookJson({ description: undefined })] }, 'looks[0].description'],
    ['an empty look field', { looks: [lookJson({ name: '   ' })] }, 'looks[0].name'],
    ['a wrong variant type', { looks: [lookJson({ variants: [1, 2] })] }, 'looks[0].variants[0]'],
    ['variants that are not a list', { looks: [lookJson({ variants: 'base' })] }, 'looks[0].variants'],
    ['an empty variant list', { looks: [lookJson({ variants: [] })] }, 'looks[0].variants'],
    [
      'a thumbnail that is neither string nor null',
      { looks: [lookJson({ thumbnail: 5 })] },
      'looks[0].thumbnail',
    ],
    ['no looks at all', { looks: [] }, 'looks'],
    ['looks that are not a list', { looks: {} }, 'looks'],
    ['a missing rotunda file', { rotunda: {} }, 'rotunda.file'],
    ['a missing environment file', { environment: {} }, 'environment.file'],
    [
      'views without the proof camera',
      { views: { orbit: { position: [0, 0, 0], target: [0, 0, 0], fov: 40 } } },
      'views.proof',
    ],
  ];

  it.each(brokenDocuments)('throws naming the field for %s', (_case, overrides, field) => {
    expect(() => parseCatalog(catalogJson(overrides))).toThrow(field);
  });

  it('throws when the default variant is not one of the variants', () => {
    const json = catalogJson({ looks: [lookJson({ defaultVariant: 'chrome' })] });
    expect(() => parseCatalog(json)).toThrow('looks[0].defaultVariant');
  });

  it('throws when two looks share an id', () => {
    const json = catalogJson({ looks: [lookJson(), lookJson()] });
    expect(() => parseCatalog(json)).toThrow('"wallis-dress" twice');
  });

  it('throws on a document version it does not read', () => {
    expect(() => parseCatalog(catalogJson({ version: 2 }))).toThrow('version');
    expect(() => parseCatalog(catalogJson({ version: '1' }))).toThrow('version');
  });

  it('throws when a camera pose is not three numbers', () => {
    const json = catalogJson({ views: { proof: { position: [0, 1.7], target: [0, 1, 0], fov: 40 } } });
    expect(() => parseCatalog(json)).toThrow('views.proof.position');
  });

  it.each([[null], [42], ['catalog'], [[]]])('throws when the document is %s', (json) => {
    expect(() => parseCatalog(json)).toThrow('catalog');
  });
});

describe('contentUrl', () => {
  it.each([
    ['/content', 'looks/wallis-dress.glb', '/content/looks/wallis-dress.glb'],
    ['/content/half', 'looks/wallis-dress.glb', '/content/half/looks/wallis-dress.glb'],
    ['/content/', '/looks/wallis-dress.glb', '/content/looks/wallis-dress.glb'],
    ['/content', 'basis/', '/content/basis/'],
  ])('joins %s and %s without a double slash', (base, file, expected) => {
    expect(contentUrl(base, file)).toBe(expected);
  });
});

describe('loadCatalog', () => {
  it('fetches the url it is given and validates the answer', async () => {
    const asked: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      asked.push(String(input));
      return new Response(JSON.stringify(catalogJson()), { status: 200 });
    };
    const catalog = await loadCatalog('/content/catalog.json', fetchFn);
    expect(asked).toEqual(['/content/catalog.json']);
    expect(catalog.looks[0].file).toBe('looks/wallis-dress.glb');
  });

  it('throws with the status when the file is not there', async () => {
    const fetchFn: typeof fetch = async () => new Response('not found', { status: 404 });
    await expect(loadCatalog('/content/half/catalog.json', fetchFn)).rejects.toThrow('404');
  });

  it('throws when the answer is not the catalogue, which is what a dev server index.html is', async () => {
    const fetchFn: typeof fetch = async () => new Response('<!doctype html>', { status: 200 });
    await expect(loadCatalog('/content/half/catalog.json', fetchFn)).rejects.toThrow();
  });
});
