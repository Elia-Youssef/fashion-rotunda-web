import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataTexture, FloatType } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

let hdrImports = 0;
beforeEach(() => {
  vi.resetModules();
  hdrImports = 0;
  vi.doMock('three/webgpu', () => ({
    PMREMGenerator: class {
      dispose() {}
      fromEquirectangular() {}
      fromScene() {}
    },
  }));
  vi.doMock('three/addons/loaders/HDRLoader.js', () => {
    hdrImports += 1;
    return {
      HDRLoader: class {
        load(_url: string, resolve: (texture: DataTexture) => void) {
          const source = new DataTexture(new Float32Array(8 * 4 * 4), 8, 4, undefined, FloatType);
          source.flipY = true;
          queueMicrotask(() => resolve(source));
          return source;
        }
      },
    };
  });
});
afterEach(() => {
  vi.doUnmock('three/webgpu');
  vi.doUnmock('three/addons/loaders/HDRLoader.js');
});

function renderer(): WebGPURenderer {
  return {
    init: async () => {},
    getRenderTarget: () => null,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    autoClear: true,
  } as unknown as WebGPURenderer;
}

describe('HDR loader loading', () => {
  it('does not import on the procedural default path', async () => {
    const { createProceduralEnvironment } = await import('../../src/lighting/environment');
    const environment = await createProceduralEnvironment(renderer());
    expect(hdrImports).toBe(0);
    environment.dispose();
  });

  it('imports once for repeated HDR diagnostics', async () => {
    const { createHdrEnvironment } = await import('../../src/lighting/environment');
    const environments = await Promise.all([
      createHdrEnvironment(renderer(), '/sky.hdr'), createHdrEnvironment(renderer(), '/sky.hdr'),
    ]);
    expect(hdrImports).toBe(1);
    environments.forEach((environment) => environment.dispose());
  });
});
