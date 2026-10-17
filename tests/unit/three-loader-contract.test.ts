import { Mesh, RectAreaLightNode, Texture } from 'three/webgpu';
import type { TextureLoader, WebGPURenderer } from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRectAreaLights } from '../../src/lighting/rect-area-ltc';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('three loader compatibility contracts', () => {
  it('exposes image loading hooks and returns null after a texture source rejection', async () => {
    vi.stubGlobal('self', { URL });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const gltf = await new GLTFLoader().parseAsync(JSON.stringify({
      asset: { version: '2.0' }, images: [{ uri: 'unused.png' }], textures: [{ source: 0 }],
    }), '');
    const parser = gltf.parser;
    expect(parser.loadImageSource).toBeTypeOf('function');
    expect(parser.loadTextureImage).toBeTypeOf('function');
    const error = new Error('image unavailable');
    const loader = {
      load: vi.fn((_url, _loaded, _progress, rejected: (error: Error) => void) => rejected(error)),
    } as unknown as TextureLoader;
    await expect(parser.loadImageSource(0, loader)).rejects.toBe(error);
    await expect(parser.loadTextureImage(0, 0, loader)).resolves.toBeNull();
  });

  it('preserves unknown variant blocks and supports material dependency and finalization hooks', async () => {
    const variants = { variants: [{ name: 'light' }, { name: 'dark' }] };
    const gltf = await new GLTFLoader().parseAsync(JSON.stringify({
      asset: { version: '2.0' }, extensionsUsed: ['KHR_materials_variants'],
      extensions: { KHR_materials_variants: variants },
      nodes: [{ extensions: { KHR_materials_variants: { mappings: [] } } }],
      scenes: [{ nodes: [0] }], scene: 0, materials: [{ name: 'variant-material' }],
    }), '');
    expect(gltf.userData['gltfExtensions']['KHR_materials_variants']).toEqual(variants);
    expect(gltf.scene.children[0].userData['gltfExtensions']['KHR_materials_variants'])
      .toEqual({ mappings: [] });
    const parser = gltf.parser;
    const material = await parser.getDependency('material', 0);
    expect(material.name).toBe('variant-material');
    const mesh = new Mesh(undefined, material);
    parser.assignFinalMaterial(mesh);
    expect(mesh.material).toHaveProperty('isMeshStandardMaterial', true);
    mesh.geometry.dispose();
    mesh.material.dispose();
    material.dispose();
  });

  it('detects KTX2 formats synchronously through initialized renderer features', () => {
    const hasFeature = vi.fn((feature: string) => feature === 'texture-compression-bc');
    const renderer = { isWebGPURenderer: true, hasFeature } as unknown as WebGPURenderer;
    const loader = new KTX2Loader();
    const returned = loader.detectSupport(renderer);
    expect(returned).toBe(loader);
    const config = (loader as unknown as { workerConfig: Record<string, boolean> }).workerConfig;
    expect(config).toEqual({
      astcSupported: false, astcHDRSupported: false, etc1Supported: false,
      etc2Supported: false, dxtSupported: false, bptcSupported: true, pvrtcSupported: false,
    });
    expect(hasFeature).toHaveBeenCalledWith('texture-compression-bc');
    loader.dispose();
  });

  it('registers real LTC data textures through the rect light node static method', () => {
    const register = vi.spyOn(RectAreaLightNode, 'setLTC');
    registerRectAreaLights();
    expect(register).toHaveBeenCalledTimes(1);
    const tables = register.mock.calls[0][0];
    for (const name of ['LTC_FLOAT_1', 'LTC_FLOAT_2', 'LTC_HALF_1', 'LTC_HALF_2'] as const) {
      expect(tables[name]).toBeInstanceOf(Texture);
      expect(tables[name].image).toMatchObject({ width: 64, height: 64 });
    }
    registerRectAreaLights();
    expect(register).toHaveBeenCalledTimes(1);
  });
});
