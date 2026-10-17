import { describe, expect, it, vi } from 'vitest';
import { CATALOG_VERSION, contentUrl, loadCatalog, parseCatalog } from '../../src/catalog/catalog';

// The fixtures are built as plain JSON so a test can delete or corrupt one field and leave the rest
// of the document valid, which is what parseCatalog has to answer for.

function lookJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'wallis-dress',
    name: 'Wallis Dress',
    description: 'Wallis Simpson wore a wedding ensemble by Mainbocher in 1937.',
    thumbnail: 'thumbs/wallis-dress.png',
    file: 'looks/wallis-dress.glb',
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
  it('accepts an optional HTTPS source URL and preserves its exact value', () => {
    const sourceUrl = 'https://example.com/source?id=42';
    const catalog = parseCatalog(catalogJson({ looks: [lookJson({ sourceUrl })] }));
    expect(catalog.looks[0].sourceUrl).toBe(sourceUrl);
    expect(Object.hasOwn(parseCatalog(catalogJson()).looks[0], 'sourceUrl')).toBe(false);
  });

  it.each([
    'http://example.com/', 'javascript:alert(1)', '/source', '//example.com', 'https://', '', null, 42,
  ])(
    'rejects a non-HTTPS or malformed source URL %j', (sourceUrl) => {
      const json = catalogJson({ looks: [lookJson({ sourceUrl })] });
      expect(() => parseCatalog(json)).toThrow('looks[0].sourceUrl');
    },
  );

  it('rejects a source URL whose https prefix is not the exact lowercase literal', () => {
    const json = catalogJson({ looks: [lookJson({ sourceUrl: 'HTTPS://example.com/source' })] });
    expect(() => parseCatalog(json)).toThrow('looks[0].sourceUrl');
  });

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

  it('keeps a null thumbnail and schema without audio', () => {
    const catalog = parseCatalog(catalogJson({ looks: [lookJson({ thumbnail: null })] }));
    expect(catalog.looks[0].thumbnail).toBeNull();
    expect(Object.hasOwn(catalog.looks[0], 'audio')).toBe(false);
  });

  it('parses both shipped catalogues without audio fields', async () => {
    const mainCatalog = (await import('../../public/content/catalog.json')).default;
    const halfCatalog = (await import('../../public/content/half/catalog.json')).default;
    const main = parseCatalog(mainCatalog);
    const half = parseCatalog(halfCatalog);
    expect(main.looks).toHaveLength(7);
    expect(half.looks).toHaveLength(7);
    for (const look of [...main.looks, ...half.looks]) {
      expect(Object.hasOwn(look, 'audio')).toBe(false);
    }
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
    ['a look that is not an object', { looks: [42] }, 'looks[0] is not an object'],
    ['a rotunda that is not an object', { rotunda: 'rotunda.glb' }, 'rotunda is not an object'],
    ['views that are not an object', { views: [] }, 'views is not an object'],
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

  it('throws when a camera pose has extra numbers, not only when it is short', () => {
    const json = catalogJson({
      views: { proof: { position: [0, 1.7, 4.2, 5], target: [0, 1, 0], fov: 40 } },
    });
    expect(() => parseCatalog(json)).toThrow('views.proof.position has 4 numbers, not 3');
  });

  it('throws when a number field is not finite, which JSON can produce from 1e999', () => {
    // JSON.parse turns an overlarge exponent into Infinity, so response.json() really can hand
    // the parser a non-finite number and the camera a broken pose.
    const json = catalogJson({
      views: { proof: { position: [0, 1.7, 4.2], target: [0, 1, 0], fov: Number('1e999') } },
    });
    expect(() => parseCatalog(json)).toThrow('views.proof.fov is not a finite number');
  });

  it('reads and validates every named view, not only the proof camera', () => {
    const views = {
      proof: { position: [0, 1.7, 4.2], target: [0, 1, 0], fov: 40 },
      orbit: { position: [3, 2, -1], target: [0, 1.2, 0], fov: 55 },
    };
    const catalog = parseCatalog(catalogJson({ views }));
    expect(catalog.views.orbit).toEqual({ position: [3, 2, -1], target: [0, 1.2, 0], fov: 55 });
    const broken = catalogJson({
      views: { ...views, orbit: { position: [3, 2], target: [0, 1.2, 0], fov: 55 } },
    });
    expect(() => parseCatalog(broken)).toThrow('views.orbit.position');
  });

  it.each([[null], [42], ['catalog'], [[]]])('throws when the document is %s', (json) => {
    expect(() => parseCatalog(json)).toThrow('catalog is not an object');
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
  it.each(['/content/catalog.json', '/content/half/catalog.json'])(
    'shares pending, fulfilled and rejected requests for %s without fetching early', async (url) => {
      let resolve!: (response: Response) => void;
      const fetchFn = vi.fn<typeof fetch>(() => new Promise<Response>((yes) => { resolve = yes; }));
      expect(fetchFn).not.toHaveBeenCalled();
      const first = loadCatalog(url, fetchFn);
      const second = loadCatalog(url, fetchFn);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      resolve(new Response(JSON.stringify(catalogJson())));
      expect(await first).toEqual(await second);
      expect(await loadCatalog(url, fetchFn)).toBe(await first);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      const failing = vi.fn<typeof fetch>(async () => new Response('missing', { status: 404 }));
      const failures = await Promise.allSettled([loadCatalog(url, failing), loadCatalog(url, failing)]);
      expect(failures.map((result) => result.status)).toEqual(['rejected', 'rejected']);
      await expect(loadCatalog(url, failing)).rejects.toThrow('404');
      expect(failing).toHaveBeenCalledTimes(1);
    },
  );

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

  it('calls its fetch implementation with the globalThis receiver the Chrome global needs', async () => {
    // Chrome's global fetch throws when called detached, so the receiver is part of the call
    // contract: the page hands loadCatalog the real global and expects it to stay bound.
    const receivers: unknown[] = [];
    const fetchFn: typeof fetch = function fetchOnGlobal(this: typeof globalThis) {
      receivers.push(this);
      return Promise.resolve(new Response(JSON.stringify(catalogJson())));
    };
    await loadCatalog('/content/catalog.json', fetchFn);
    expect(receivers).toEqual([globalThis]);
  });
});
