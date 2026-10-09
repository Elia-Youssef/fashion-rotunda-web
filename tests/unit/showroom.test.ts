import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import type { GLTF, GLTFLoader, GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Catalog } from '../../src/catalog/catalog';
import { CROSSFADE_MS, MAX_FADE_STEP_MS } from '../../src/scene/crossfade';
import { createShowroom } from '../../src/scene/showroom';
import type { Showroom } from '../../src/scene/showroom';

const { createGltfLoader, parseAsync } = vi.hoisted(() => ({
  createGltfLoader: vi.fn<() => Promise<GLTFLoader>>(),
  parseAsync: vi.fn<(bytes: ArrayBuffer | string, path: string) => Promise<GLTF>>(),
}));

vi.mock('../../src/scene/loaders', () => ({ createGltfLoader }));

const CONTENT_BASE = '/content';
const VARIANTS = ['base', 'light', 'dark'];
// A centred two-metre box gives the plinth a known top at one metre.
const PLINTH_SIZE = 2;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function lookFixture(name: string) {
  const root = new Group();
  root.name = name;
  const texture = new Texture();
  const materials = VARIANTS.map((variant) => new MeshStandardMaterial({
    name: `${name}-${variant}`,
    map: texture,
    normalMap: texture,
  }));
  const geometry = new BoxGeometry(PLINTH_SIZE, PLINTH_SIZE, PLINTH_SIZE);
  const original = new MeshStandardMaterial({ name: `${name}-original`, map: texture });
  const mannequin = new Mesh(geometry, original);
  mannequin.userData['gltfExtensions'] = {
    KHR_materials_variants: {
      mappings: materials.map((_material, index) => ({ material: index, variants: [index] })),
    },
  };
  // Resource sets must handle repeated geometry, material arrays and shared texture slots.
  const garment = new Mesh(geometry, [materials[0], materials[0]]);
  root.add(mannequin, garment);
  // Only these parser methods are used by the real variant helper.
  const parser: GLTFParser = Object.create(null);
  parser.getDependency = vi.fn(async (_type: string, index: number) => materials[index]);
  parser.assignFinalMaterial = vi.fn();
  const gltf: GLTF = Object.create(null);
  gltf.scene = root;
  gltf.parser = parser;
  gltf.userData = {
    gltfExtensions: { KHR_materials_variants: { variants: VARIANTS.map((name) => ({ name })) } },
  };
  const disposal = {
    geometry: vi.spyOn(geometry, 'dispose'),
    materials: materials.map((material) => vi.spyOn(material, 'dispose')),
    original: vi.spyOn(original, 'dispose'),
    texture: vi.spyOn(texture, 'dispose'),
  };
  return { gltf, root, geometry, mannequin, garment, materials, parser, disposal };
}

function harness() {
  const catalog: Catalog = {
    version: 1,
    environment: { file: 'sky.hdr' },
    rotunda: { file: 'rotunda.glb' },
    plinth: { file: 'plinth.glb' },
    looks: ['first', 'second'].map((id) => ({
      id, name: id, description: id, thumbnail: null, file: `looks/${id}.glb`,
      variants: VARIANTS, defaultVariant: 'base', mannequinNode: 'mannequin',
    })),
    views: { proof: { position: [0, 2, 5], target: [0, 1, 0], fov: 45 } },
  };
  const first = lookFixture('first');
  const second = lookFixture('second');
  const rotunda = lookFixture('rotunda');
  const plinth = lookFixture('plinth');
  const files = new Map([
    ['/content/rotunda.glb', rotunda.gltf], ['/content/plinth.glb', plinth.gltf],
    ['/content/looks/first.glb', first.gltf], ['/content/looks/second.glb', second.gltf],
  ]);
  const requests: { url: string; signal: AbortSignal | null | undefined }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!files.has(url)) throw new Error(`unexpected fetch: ${url}`);
    requests.push({ url, signal: init?.signal });
    return new Response(url);
  });
  vi.stubGlobal('fetch', fetchMock);
  parseAsync.mockImplementation(async (bytes) => {
    const url = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
    const gltf = files.get(url);
    if (gltf === undefined) throw new Error(`unexpected parse: ${url}`);
    return gltf;
  });
  const renderer: WebGPURenderer = Object.create(null);
  const onChange = vi.fn();
  const decorate = vi.fn();
  const showroom = createShowroom({ renderer, catalog, contentBase: CONTENT_BASE, onChange, decorate });

  function pauseFirstParse() {
    const entered = deferred<void>();
    const result = deferred<GLTF>();
    parseAsync.mockImplementationOnce(() => {
      entered.resolve();
      return result.promise;
    });
    return { entered: entered.promise, ...result };
  }
  return { showroom, first, second, rotunda, plinth, requests, fetchMock, onChange, decorate, pauseFirstParse };
}

async function finishFade(showroom: Showroom): Promise<void> {
  const settled = showroom.settle();
  for (let elapsed = 0; elapsed < CROSSFADE_MS; elapsed += MAX_FADE_STEP_MS) {
    showroom.update(MAX_FADE_STEP_MS);
  }
  await settled;
}

beforeEach(() => {
  vi.resetAllMocks();
  const loader: GLTFLoader = Object.create(null);
  loader.parseAsync = parseAsync;
  createGltfLoader.mockResolvedValue(loader);
  vi.stubGlobal('window', { matchMedia: vi.fn(() => ({ matches: false })) });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  performance.clearMarks('look-switch-start');
  performance.clearMeasures('look-switch');
});

describe('createShowroom', () => {
  it('loads each static once at startup and retains it through look switches', async () => {
    const { showroom, rotunda, plinth, first, second, requests, decorate } = harness();
    await showroom.loadStatics();
    await showroom.showLook('first');
    await showroom.showLook('second');
    await finishFade(showroom);

    expect(requests.map(({ url }) => url)).toEqual([
      '/content/rotunda.glb', '/content/plinth.glb',
      '/content/looks/first.glb', '/content/looks/second.glb',
    ]);
    expect(createGltfLoader).toHaveBeenCalledTimes(1);
    expect(parseAsync.mock.calls.map(([, directory]) => directory)).toEqual([
      '/content/', '/content/', '/content/looks/', '/content/looks/',
    ]);
    expect(rotunda.root.parent).toBe(showroom.scene);
    expect(plinth.root.parent).toBe(second.root.parent);
    expect(showroom.turntableState.plinthAttached).toBe(true);
    expect(second.root.position.y).toBe(PLINTH_SIZE / 2);
    expect(first.root.parent).toBeNull();
    expect(decorate.mock.calls.map(([root]) => root)).toEqual([
      rotunda.root, plinth.root, first.root, second.root,
    ]);
    expect(rotunda.disposal.geometry).not.toHaveBeenCalled();
    expect(plinth.disposal.geometry).not.toHaveBeenCalled();
  });

  it('keeps the latest overlapping request and disposes a stale parsed look', async () => {
    const { showroom, first, second, requests, onChange, pauseFirstParse } = harness();
    const parse = pauseFirstParse();
    const older = showroom.showLook('first');
    await parse.entered;
    await showroom.showLook('second');
    // Parsing is already past fetch and still resolves after its signal is aborted.
    parse.resolve(first.gltf);
    await older;

    expect(showroom.currentLook).toBe('second');
    expect(requests[0].signal?.aborted).toBe(true);
    expect(requests[1].signal?.aborted).toBe(false);
    expect(second.root.parent).not.toBeNull();
    expect(first.root.parent).toBeNull();
    expect(first.disposal.geometry).toHaveBeenCalledTimes(1);
    expect(first.disposal.materials[0]).toHaveBeenCalledTimes(1);
    expect(first.disposal.original).toHaveBeenCalledTimes(1);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);
    expect(second.disposal.geometry).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('disposes replaced geometry, original and variant materials, and shared textures after the fade', async () => {
    const { showroom, first, second } = harness();
    await showroom.showLook('first');
    await showroom.setVariant('light');
    await showroom.setVariant('dark');
    await showroom.showLook('second');
    expect(showroom.fading).toBe(true);
    expect(first.root.parent).toBe(second.root.parent);
    expect(first.disposal.geometry).not.toHaveBeenCalled();
    for (const dispose of first.disposal.materials) expect(dispose).not.toHaveBeenCalled();
    expect(first.disposal.original).not.toHaveBeenCalled();
    expect(first.disposal.texture).not.toHaveBeenCalled();

    await finishFade(showroom);
    showroom.update(MAX_FADE_STEP_MS);

    expect(showroom.fading).toBe(false);
    expect(first.root.parent).toBeNull();
    expect(first.disposal.geometry).toHaveBeenCalledTimes(1);
    for (const dispose of first.disposal.materials) expect(dispose).toHaveBeenCalledTimes(1);
    expect(first.disposal.original).toHaveBeenCalledTimes(1);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);
    expect(second.root.parent).not.toBeNull();
    expect(second.disposal.geometry).not.toHaveBeenCalled();
    for (const dispose of second.disposal.materials) expect(dispose).not.toHaveBeenCalled();
    expect(second.disposal.original).not.toHaveBeenCalled();
    expect(second.disposal.texture).not.toHaveBeenCalled();
  });

  it('applies a variant to the current incoming look while leaving the outgoing look alone', async () => {
    const { showroom, first, second } = harness();
    await showroom.showLook('first');
    await showroom.showLook('second');
    expect(showroom.fading).toBe(true);
    await showroom.setVariant('light');

    expect(showroom.currentLook).toBe('second');
    expect(showroom.currentVariant).toBe('light');
    expect(second.mannequin.material).toBe(second.materials[1]);
    expect(second.garment.material).toEqual([second.materials[0], second.materials[0]]);
    expect(first.mannequin.material).toBe(first.materials[0]);
    expect(first.parser.getDependency).toHaveBeenCalledTimes(1);
    expect(second.parser.getDependency).toHaveBeenLastCalledWith('material', 1);
    await finishFade(showroom);
  });

  it('rejects an unknown look before fetching or changing the scene', async () => {
    const { showroom, fetchMock, onChange } = harness();
    await expect(showroom.showLook('missing')).rejects.toThrow(
      'no look with the id "missing" in the catalogue',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(showroom.currentLook).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects variant selection without a look on screen', async () => {
    const { showroom, onChange } = harness();
    await expect(showroom.setVariant('light')).rejects.toThrow(
      'setVariant("light") needs a look on screen',
    );
    expect(showroom.currentVariant).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects an unavailable variant without changing the material or selected variant', async () => {
    const { showroom, first, onChange } = harness();
    await showroom.showLook('first');
    await expect(showroom.setVariant('missing')).rejects.toThrow(
      'the look "first" has no variant "missing"',
    );
    expect(first.mannequin.material).toBe(first.materials[0]);
    expect(first.parser.getDependency).toHaveBeenCalledTimes(1);
    expect(showroom.currentVariant).toBe('base');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reports a static HTTP failure without attaching partial statics', async () => {
    const { showroom, rotunda, plinth, fetchMock, onChange } = harness();
    // The response status is part of the public error message, not a timing or a budget.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(showroom.loadStatics()).rejects.toThrow('content: /content/rotunda.glb answered 503');
    expect(rotunda.root.parent).toBeNull();
    expect(plinth.root.parent).toBeNull();
    expect(showroom.turntableState.plinthAttached).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports a current look HTTP failure, preserves the visible look, and permits a retry', async () => {
    const { showroom, first, second, fetchMock, onChange } = harness();
    await showroom.showLook('first');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(showroom.showLook('second')).rejects.toThrow(
      'content: /content/looks/second.glb answered 404',
    );
    expect(showroom.currentLook).toBe('first');
    expect(first.root.parent).not.toBeNull();
    expect(first.disposal.geometry).not.toHaveBeenCalled();
    expect(showroom.fading).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);

    await showroom.showLook('second');
    expect(showroom.currentLook).toBe('second');
    expect(second.root.parent).not.toBeNull();
    await finishFade(showroom);
  });

  it('propagates a current parser error without replacing the visible look', async () => {
    const { showroom, first, onChange } = harness();
    await showroom.showLook('first');
    const failure = new Error('invalid glTF');
    parseAsync.mockRejectedValueOnce(failure);
    await expect(showroom.showLook('second')).rejects.toBe(failure);
    expect(showroom.currentLook).toBe('first');
    expect(first.root.parent).not.toBeNull();
    expect(first.disposal.geometry).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('resolves a superseded parser failure while keeping the winning look', async () => {
    const { showroom, second, onChange, pauseFirstParse } = harness();
    const parse = pauseFirstParse();
    const older = showroom.showLook('first');
    await parse.entered;
    await showroom.showLook('second');
    const resolved = expect(older).resolves.toBeUndefined();
    parse.reject(new Error('retired parse failed'));
    await resolved;
    expect(showroom.currentLook).toBe('second');
    expect(second.root.parent).not.toBeNull();
    expect(second.disposal.geometry).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
