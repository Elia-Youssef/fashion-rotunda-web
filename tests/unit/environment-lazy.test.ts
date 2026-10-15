import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataTexture, FloatType } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

let hdrImports = 0;
let roomImports = 0;
beforeEach(() => {
  vi.resetModules();
  hdrImports = 0;
  roomImports = 0;
  vi.doMock('three/addons/environments/RoomEnvironment.js', () => {
    roomImports += 1;
    return { RoomEnvironment: class { dispose() {} } };
  });
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
  vi.doUnmock('three/addons/environments/RoomEnvironment.js');
});

describe('room fallback loading', () => {
  it('does not import on successful procedural or HDR paths', async () => {
    const { createProceduralEnvironment, createHdrEnvironment } = await import('../../src/lighting/environment');
    const environments = await Promise.all([
      createProceduralEnvironment(renderer()), createHdrEnvironment(renderer(), '/sky.hdr'),
    ]);
    expect(roomImports).toBe(0);
    environments.forEach((environment) => environment.dispose());
  });

  it('imports once when the fallback factory is requested repeatedly', async () => {
    const { createRoomEnvironment } = await import('../../src/lighting/environment');
    const environments = await Promise.all([
      createRoomEnvironment(renderer()), createRoomEnvironment(renderer()),
    ]);
    expect(roomImports).toBe(1);
    environments.forEach((environment) => environment.dispose());
  });

  it('forgets a failed room import, so the next fallback factory retries it', async () => {
    let failNext = true;
    vi.doMock('three/addons/environments/RoomEnvironment.js', async () => {
      roomImports += 1;
      if (failNext) {
        failNext = false;
        throw new Error('chunk unavailable');
      }
      return { RoomEnvironment: class { dispose() {} } };
    });
    const { createRoomEnvironment } = await import('../../src/lighting/environment');

    // A failing vi.doMock factory surfaces as vitest's wrapped mocking error, so the assertion is
    // on the rejection reaching the caller; the original error rides along as its cause.
    await expect(createRoomEnvironment(renderer())).rejects.toThrow();
    expect(roomImports).toBe(1);

    const environment = await createRoomEnvironment(renderer());
    expect(roomImports).toBe(2);
    environment.dispose();
  });
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

  it('forgets a failed HDR loader import, so the next diagnostic retries it', async () => {
    let failNext = true;
    vi.doMock('three/addons/loaders/HDRLoader.js', async () => {
      hdrImports += 1;
      if (failNext) {
        failNext = false;
        throw new Error('chunk unavailable');
      }
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
    const { createHdrEnvironment } = await import('../../src/lighting/environment');

    // Same wrapped-error shape as the room import test above.
    await expect(createHdrEnvironment(renderer(), '/sky.hdr')).rejects.toThrow();
    expect(hdrImports).toBe(1);

    const environment = await createHdrEnvironment(renderer(), '/sky.hdr');
    expect(hdrImports).toBe(2);
    environment.dispose();
  });
});
