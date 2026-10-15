import { Texture, TextureLoader } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGltfLoader } from '../../src/scene/loaders';
import { createShowroom } from '../../src/scene/showroom';
import type { Catalog } from '../../src/catalog/catalog';

const { loadTexture } = vi.hoisted(() => ({ loadTexture: vi.fn() }));
vi.mock('three/addons/loaders/KTX2Loader.js', () => ({
  KTX2Loader: class {
    setTranscoderPath(): this { return this; }
    detectSupport(): this { return this; }
    load = loadTexture;
  },
}));

/** Real GLTFLoader parsing, with just the image download/transcode boundary controlled. */
function documentWithTextures(basis = true, visible = true): string {
  return JSON.stringify({
    asset: { version: '2.0' },
    extensionsUsed: basis ? ['KHR_texture_basisu'] : [],
    extensionsRequired: basis ? ['KHR_texture_basisu'] : [],
    scene: 0,
    scenes: [{ nodes: visible ? [0] : [] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    accessors: [{ componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [0, 1, 0] }],
    images: [{ uri: basis ? 'surface.ktx2' : 'surface.png' }],
    textures: [0, 1].map((sampler) => basis
      ? { sampler, extensions: { KHR_texture_basisu: { source: 0 } } }
      : { sampler, source: 0 }),
    samplers: [{}, { wrapS: 33071 }],
    materials: [0, 1].map((index) => ({ pbrMetallicRoughness: { baseColorTexture: { index } } })),
  });
}

const renderer: WebGPURenderer = Object.create(null);

function showroomWithTextures() {
  const catalog: Catalog = {
    version: 1,
    environment: { file: 'sky.hdr' },
    rotunda: { file: 'rotunda.glb' },
    plinth: { file: 'plinth.glb' },
    looks: ['first', 'second'].map((id) => ({
      id, name: id, description: id, thumbnail: null, file: `looks/${id}.glb`,
      variants: [], defaultVariant: 'base', mannequinNode: 'mannequin',
    })),
    views: { proof: { position: [0, 2, 5], target: [0, 1, 0], fov: 45 } },
  };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(documentWithTextures())));
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  const onChange = vi.fn();
  return {
    onChange,
    showroom: createShowroom({ renderer, catalog, contentBase: '/content', onChange }),
  };
}

beforeEach(() => {
  loadTexture.mockReset();
  loadTexture.mockImplementation((_url, onLoad: (texture: Texture) => void) => {
    onLoad(new Texture());
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal('self', globalThis);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('required glTF textures', () => {
  it.each([
    'Basis WASM download failed',
    'Basis wrapper download failed',
    'Basis initialization failed',
    'texture transcode failed',
  ])('rejects parsing with the original cause when %s', async (message) => {
    const failure = new Error(message);
    loadTexture.mockImplementation((_url, _onLoad, _onProgress, onError: (error: Error) => void) => {
      queueMicrotask(() => onError(failure));
    });
    const loader = await createGltfLoader(renderer, '/content');

    await expect(loader.parseAsync(documentWithTextures(), '/content/')).rejects.toBe(failure);
  });

  it('propagates a synchronous texture loader failure too', async () => {
    const failure = new Error('transcoder setup threw');
    loadTexture.mockImplementation(() => { throw failure; });
    const loader = await createGltfLoader(renderer, '/content');

    await expect(loader.parseAsync(documentWithTextures(), '/content/')).rejects.toBe(failure);
  });

  it('rejects a lazy variant material and every sampler sharing the failed image', async () => {
    const failure = new Error('late texture transcode failed');
    const loader = await createGltfLoader(renderer, '/content');
    const gltf = await loader.parseAsync(documentWithTextures(true, false), '/content/');
    loadTexture.mockImplementation((_url, _onLoad, _onProgress, onError: (error: Error) => void) => {
      onError(failure);
    });

    await expect(gltf.parser.getDependency('material', 0)).rejects.toBe(failure);
    await expect(gltf.parser.getDependency('material', 1)).rejects.toBe(failure);
    // GLTFLoader caches the failed source; both texture dependencies must still reject.
    expect(loadTexture).toHaveBeenCalledTimes(1);
  });

  it('keeps overlapping parses independent and preserves successful texture configuration', async () => {
    const failure = new Error('one document failed');
    const otherFailure = new Error('another document failed');
    loadTexture.mockImplementationOnce((_url, _onLoad, _onProgress, onError: (error: Error) => void) => {
      queueMicrotask(() => onError(failure));
    }).mockImplementationOnce((_url, _onLoad, _onProgress, onError: (error: Error) => void) => {
      queueMicrotask(() => onError(otherFailure));
    });
    const loader = await createGltfLoader(renderer, '/content');
    const results = await Promise.allSettled([
      loader.parseAsync(documentWithTextures(), '/failed/'),
      loader.parseAsync(documentWithTextures(), '/also-failed/'),
      loader.parseAsync(documentWithTextures(), '/successful/'),
    ]);
    expect(results[0]).toEqual({ status: 'rejected', reason: failure });
    expect(results[1]).toEqual({ status: 'rejected', reason: otherFailure });
    const successful = results[2];
    expect(successful.status).toBe('fulfilled');
    if (successful.status !== 'fulfilled') throw successful.reason;
    const texture: Texture = await successful.value.parser.getDependency('texture', 0);
    expect(texture).toBeInstanceOf(Texture);
    expect(texture.flipY).toBe(false);
    expect(texture.name).toBe('surface.ktx2');
  });

  it('also rejects ordinary image failures at the same swallowed-error boundary', async () => {
    const failure = new Error('PNG download failed');
    vi.spyOn(TextureLoader.prototype, 'load').mockImplementation((_url, _onLoad, _progress, onError) => {
      onError?.(failure);
      return new Texture();
    });
    const loader = await createGltfLoader(renderer, '/content');

    await expect(loader.parseAsync(documentWithTextures(false), '/content/')).rejects.toBe(failure);
  });

  it('rejects the first-frame static and look loads before they attach', async () => {
    const failure = new Error('startup transcoder unavailable');
    loadTexture.mockImplementation((_url, _onLoad, _onProgress, onError: (error: Error) => void) => {
      onError(failure);
    });
    const { showroom, onChange } = showroomWithTextures();

    const results = await Promise.allSettled([showroom.loadStatics(), showroom.showLook('first')]);
    expect(results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    expect(showroom.currentLook).toBeNull();
    expect(showroom.turntableState.plinthAttached).toBe(false);
    expect(showroom.turntableState.activeLookAttached).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects a later texture failure and keeps the previous look attached without a fade', async () => {
    const { showroom, onChange } = showroomWithTextures();
    await showroom.showLook('first');
    const failure = new Error('later texture transcode failed');
    loadTexture.mockImplementation((_url, _onLoad, _onProgress, onError: (error: Error) => void) => {
      onError(failure);
    });

    await expect(showroom.showLook('second')).rejects.toBe(failure);
    expect(showroom.currentLook).toBe('first');
    expect(showroom.turntableState.activeLookAttached).toBe(true);
    expect(showroom.turntableState.outgoingLookAttached).toBe(false);
    expect(showroom.fading).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
