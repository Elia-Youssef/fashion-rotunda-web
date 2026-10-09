import { Scene } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A small, valid rig configuration; no shadow texture is allocated by these tests.
const TEST_SHADOW_MAP_SIZE = 1024;

const stubs = vi.hoisted(() => {
  const tables = Object.freeze({ ltc: 'initialized tables' });
  const environment = { apply: vi.fn(), dispose: vi.fn() };
  return {
    tables,
    init: vi.fn(() => tables),
    setLTC: vi.fn(),
    createEnvironment: vi.fn(async () => environment),
  };
});

// Stub the texture and shader boundaries; the registration module itself stays real.
vi.mock('three/webgpu', () => ({ RectAreaLightNode: { setLTC: stubs.setLTC } }));
vi.mock('three/addons/lights/RectAreaLightTexturesLib.js', () => ({
  RectAreaLightTexturesLib: { init: stubs.init },
}));
vi.mock('../../src/lighting/environment', () => ({
  createProceduralEnvironment: stubs.createEnvironment,
  createHdrEnvironment: stubs.createEnvironment,
  createRoomEnvironment: stubs.createEnvironment,
}));
vi.mock('../../src/ui/lightpanel', () => ({ mountLightPanel: vi.fn() }));
vi.mock('../../src/lighting/three-rig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lighting/three-rig')>();
  return { ...actual, createThreeRig: vi.fn(actual.createThreeRig) };
});

beforeEach(() => {
  // Each test gets a fresh module-level registration flag, regardless of suite order.
  vi.resetModules();
  vi.clearAllMocks();
});

describe('registerRectAreaLights', () => {
  it('initializes lazily and synchronously passes the exact tables to the light node', async () => {
    const { registerRectAreaLights } = await import('../../src/lighting/rect-area-ltc');
    expect(stubs.init).not.toHaveBeenCalled();
    expect(stubs.setLTC).not.toHaveBeenCalled();

    registerRectAreaLights();

    expect(stubs.init).toHaveBeenCalledTimes(1);
    expect(stubs.setLTC).toHaveBeenCalledTimes(1);
    expect(stubs.setLTC.mock.calls[0]).toEqual([stubs.tables]);
    expect(stubs.setLTC.mock.calls[0][0]).toBe(stubs.tables);
    expect(stubs.init.mock.invocationCallOrder[0]).toBeLessThan(stubs.setLTC.mock.invocationCallOrder[0]);
  });

  it('initializes and registers once across repeated calls and consumers', async () => {
    const first = await import('../../src/lighting/rect-area-ltc');
    first.registerRectAreaLights();
    first.registerRectAreaLights();
    const second = await import('../../src/lighting/rect-area-ltc');
    second.registerRectAreaLights();
    second.registerRectAreaLights();

    expect(stubs.init).toHaveBeenCalledTimes(1);
    expect(stubs.setLTC).toHaveBeenCalledTimes(1);
    expect(stubs.setLTC.mock.calls[0][0]).toBe(stubs.tables);
  });

  it('registers before environment creation and studio rig construction in composition', async () => {
    const { composeLighting } = await import('../../src/lighting/compose');
    const { createThreeRig } = await import('../../src/lighting/three-rig');
    const renderer = { shadowMap: { enabled: false }, toneMappingExposure: 1 };
    const scene = new Scene();
    const options = {
      renderer: renderer as unknown as WebGPURenderer,
      scene,
      panelRoot: null,
      shadowMapSize: TEST_SHADOW_MAP_SIZE,
      sunShadow: true,
      onChange: vi.fn(),
    };

    const lighting = await composeLighting(options);
    const another = await composeLighting(options);

    try {
      expect(stubs.init).toHaveBeenCalledTimes(1);
      expect(stubs.setLTC).toHaveBeenCalledTimes(1);
      expect(stubs.setLTC.mock.calls[0][0]).toBe(stubs.tables);
      expect(stubs.createEnvironment).toHaveBeenCalledTimes(2);
      expect(createThreeRig).toHaveBeenCalledTimes(2);
      const registrationOrder = stubs.setLTC.mock.invocationCallOrder[0];
      expect(registrationOrder).toBeLessThan(stubs.createEnvironment.mock.invocationCallOrder[0]);
      expect(registrationOrder).toBeLessThan(vi.mocked(createThreeRig).mock.invocationCallOrder[0]);
      expect(scene.children).toHaveLength(2);
    } finally {
      lighting.dispose();
      another.dispose();
    }
  });
});
