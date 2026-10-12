import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebGPURenderer } from 'three/webgpu';

import { createGltfLoader, transcoderPath } from '../../src/scene/loaders';

// createGltfLoader runs against doubles of the three three.js pieces it wires, mocked at the
// module boundary. The doubles chain fluently like the real loaders and record every call, so the
// tests exercise the factory's real code path: which methods it calls, in what order, with what.
// The decoder's ready promise is a gate a test holds shut, which is the only way to see the
// factory wait on it rather than trust the await keyword.

const loaderDoubles = vi.hoisted(() => {
  const events: string[] = [];
  const transcoderPaths: string[] = [];
  const supportRenderers: unknown[] = [];
  const attachedKtx2: unknown[] = [];
  const attachedDecoders: unknown[] = [];
  const gltfLoaders: unknown[] = [];
  const meshoptDecoder = { ready: Promise.resolve() };
  let releaseReady: (() => void) | null = null;

  class KTX2LoaderDouble {
    constructor() {
      events.push('ktx2:constructed');
    }
    setTranscoderPath(path: string): this {
      transcoderPaths.push(path);
      return this;
    }
    detectSupport(renderer: unknown): this {
      supportRenderers.push(renderer);
      events.push('ktx2:detectSupport');
      return this;
    }
  }

  class GLTFLoaderDouble {
    constructor() {
      gltfLoaders.push(this);
      events.push('gltf:constructed');
    }
    setKTX2Loader(ktx2: unknown): this {
      attachedKtx2.push(ktx2);
      return this;
    }
    setMeshoptDecoder(decoder: unknown): this {
      attachedDecoders.push(decoder);
      return this;
    }
  }

  return {
    events,
    transcoderPaths,
    supportRenderers,
    attachedKtx2,
    attachedDecoders,
    gltfLoaders,
    meshoptDecoder,
    GLTFLoaderDouble,
    KTX2LoaderDouble,
    gateReady(): void {
      meshoptDecoder.ready = new Promise<void>((resolve) => {
        releaseReady = resolve;
      });
    },
    releaseReady(): void {
      if (releaseReady === null) {
        throw new Error('gateReady() must run before releaseReady()');
      }
      const release = releaseReady;
      releaseReady = null;
      release();
    },
  };
});

vi.mock('three/addons/loaders/GLTFLoader.js', () => ({ GLTFLoader: loaderDoubles.GLTFLoaderDouble }));
vi.mock('three/addons/loaders/KTX2Loader.js', () => ({ KTX2Loader: loaderDoubles.KTX2LoaderDouble }));
vi.mock('three/addons/libs/meshopt_decoder.module.js', () => ({
  MeshoptDecoder: loaderDoubles.meshoptDecoder,
}));

describe('transcoderPath', () => {
  it.each([
    ['/content', '/content/basis/'],
    ['/content/', '/content/basis/'],
    ['/content/half', '/content/basis/'],
    ['/content/half/', '/content/basis/'],
  ])('uses the shared transcoder for %s', (contentBase, expected) => {
    expect(transcoderPath(contentBase)).toBe(expected);
  });
});

describe('createGltfLoader', () => {
  const renderer: WebGPURenderer = Object.create(null);

  /** One macrotask boundary: the factory's synchronous prefix has run by the time it resolves. */
  function flush(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  beforeEach(() => {
    loaderDoubles.events.length = 0;
    loaderDoubles.transcoderPaths.length = 0;
    loaderDoubles.supportRenderers.length = 0;
    loaderDoubles.attachedKtx2.length = 0;
    loaderDoubles.attachedDecoders.length = 0;
    loaderDoubles.gltfLoaders.length = 0;
    loaderDoubles.meshoptDecoder.ready = Promise.resolve();
  });

  it.each([
    ['/content'],
    ['/content/half/'],
  ])('sets the shared transcoder path on the KTX2 loader for %s', async (contentBase) => {
    await createGltfLoader(renderer, contentBase);
    expect(loaderDoubles.transcoderPaths).toEqual(['/content/basis/']);
  });

  it('detects KTX2 support against the renderer it is given', async () => {
    await createGltfLoader(renderer, '/content');

    expect(loaderDoubles.supportRenderers).toHaveLength(1);
    expect(loaderDoubles.supportRenderers[0]).toBe(renderer);
  });

  it('awaits the meshopt decoder before any loader exists, let alone comes back', async () => {
    loaderDoubles.gateReady();
    const pending = createGltfLoader(renderer, '/content');

    await flush();
    // The KTX2 setup is done; the decoder is still compiling, so no GLTFLoader exists yet.
    expect(loaderDoubles.events).toContain('ktx2:detectSupport');
    expect(loaderDoubles.gltfLoaders).toHaveLength(0);

    loaderDoubles.releaseReady();
    const loader = await pending;
    expect(loaderDoubles.gltfLoaders).toHaveLength(1);
    expect(loader).toBe(loaderDoubles.gltfLoaders[0]);
  });

  it('attaches the KTX2 loader and the meshopt decoder to the loader it returns', async () => {
    const loader = await createGltfLoader(renderer, '/content');

    expect(loaderDoubles.attachedKtx2).toHaveLength(1);
    expect(loaderDoubles.attachedKtx2[0]).toBeInstanceOf(loaderDoubles.KTX2LoaderDouble);
    expect(loaderDoubles.attachedDecoders).toHaveLength(1);
    expect(loaderDoubles.attachedDecoders[0]).toBe(loaderDoubles.meshoptDecoder);
    expect(loader).toBe(loaderDoubles.gltfLoaders[0]);
  });
});
