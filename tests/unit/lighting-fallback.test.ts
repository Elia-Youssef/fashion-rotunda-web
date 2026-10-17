import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Color, Group, Scene, Texture } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

const factories = vi.hoisted(() => ({ procedural: vi.fn(), hdr: vi.fn(), room: vi.fn() }));
vi.mock('../../src/lighting/environment', () => ({
  createProceduralEnvironment: factories.procedural,
  createHdrEnvironment: factories.hdr,
  createRoomEnvironment: factories.room,
}));
vi.mock('../../src/lighting/rect-area-ltc', () => ({ registerRectAreaLights: vi.fn() }));
vi.mock('../../src/lighting/three-rig', () => ({
  createThreeRig: () => ({ group: new Group(), apply: vi.fn(), dispose: vi.fn() }),
}));

import { composeLighting } from '../../src/lighting/compose';
import { DEFAULT_RIG, daylightParameters } from '../../src/lighting/rig';

// Pin the existing lighting contributions independently of the implementation constants.
const REFERENCE_SCALES = { procedural: 0.927, hdr: 0.2, room: 0.35 };

function environment(background: Texture | null) {
  const texture = new Texture();
  return {
    texture,
    apply: vi.fn((scene: Scene, intensity: number, backgroundIntensity: number) => {
      scene.environment = texture;
      scene.environmentIntensity = intensity;
      if (background !== null) {
        scene.background = background;
        scene.backgroundIntensity = backgroundIntensity;
      }
    }),
    dispose: vi.fn(),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('environment selection and fallback', () => {
  it('updates the procedural palette before applying the scene and retains it after an update failure', async () => {
    const scene = new Scene();
    const selected = { ...environment(new Texture()), updateDaylight: vi.fn() };
    factories.procedural.mockResolvedValue(selected);
    const lighting = await composeLighting({
      scene, renderer: { shadowMap: {} } as WebGPURenderer, panelRoot: null,
      shadowMapSize: 512, sunShadow: false, onChange: vi.fn(), initial: 'v2;day,0.25',
    });
    expect(selected.updateDaylight).toHaveBeenCalledExactlyOnceWith(0.25);
    expect(selected.updateDaylight.mock.invocationCallOrder[0]).toBeLessThan(selected.apply.mock.invocationCallOrder[0]);
    const error = new Error('update failed');
    selected.updateDaylight.mockImplementationOnce(() => { throw error; });
    lighting.apply({ ...DEFAULT_RIG, daylight: 0 });
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      '[archviz] sky palette update failed; keeping the previous environment', error);
    expect(scene.environment).toBe(selected.texture);
    expect(scene.environmentIntensity).toBe(daylightParameters(0).skyIntensity * REFERENCE_SCALES.procedural);
    expect(selected.dispose).not.toHaveBeenCalled();
    lighting.dispose();
  });

  it.each(['procedural', 'hdr'] as const)('keeps the %s sky, background and intensity on success', async (name) => {
    const scene = new Scene();
    const renderer = { shadowMap: { enabled: false }, toneMappingExposure: 0 };
    const background = new Texture();
    const selected = environment(background);
    factories[name].mockResolvedValue(selected);
    const lighting = await composeLighting({
      scene, renderer: renderer as unknown as WebGPURenderer, panelRoot: null,
      shadowMapSize: 512, sunShadow: false, onChange: vi.fn(), environmentUrl: '/sky.hdr',
      sky: name === 'hdr' ? 'hdr' : null,
    });
    expect(factories[name]).toHaveBeenCalledTimes(1);
    if (name === 'hdr') expect(factories.hdr).toHaveBeenCalledWith(renderer, '/sky.hdr');
    else expect(factories.procedural).toHaveBeenCalledWith(renderer);
    expect(factories[name === 'hdr' ? 'procedural' : 'hdr']).not.toHaveBeenCalled();
    expect(factories.room).not.toHaveBeenCalled();
    expect(scene.environment).toBe(selected.texture);
    expect(scene.background).toBe(background);
    const daylight = daylightParameters(DEFAULT_RIG.daylight);
    const scale = REFERENCE_SCALES[name];
    expect(scene.environmentIntensity).toBe(daylight.skyIntensity * scale);
    expect(scene.backgroundIntensity).toBe(daylight.backgroundIntensity);
    expect(renderer.toneMappingExposure).toBe(DEFAULT_RIG.exposure);
    expect(console.warn).not.toHaveBeenCalled();
    lighting.dispose();
    expect(selected.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(['procedural', 'hdr'] as const)('keeps the same room fallback after the %s sky fails', async (name) => {
    const error = { reason: 'sky failed' };
    const scene = new Scene();
    const background = new Color(0x15181c);
    scene.background = background;
    const renderer = { shadowMap: { enabled: false }, toneMappingExposure: 0 };
    const fallback = environment(null);
    factories[name].mockRejectedValue(error);
    factories.room.mockResolvedValue(fallback);
    const lighting = await composeLighting({
      scene, renderer: renderer as unknown as WebGPURenderer, panelRoot: null,
      shadowMapSize: 512, sunShadow: false, onChange: vi.fn(), environmentUrl: '/sky.hdr',
      sky: name === 'hdr' ? 'hdr' : null,
    });
    expect(factories[name]).toHaveBeenCalledTimes(1);
    expect(factories[name === 'hdr' ? 'procedural' : 'hdr']).not.toHaveBeenCalled();
    expect(factories.room).toHaveBeenCalledExactlyOnceWith(renderer);
    expect(scene.environment).toBe(fallback.texture);
    expect(scene.background).toBe(background);
    expect(scene.environmentIntensity).toBe(daylightParameters(DEFAULT_RIG.daylight).skyIntensity * REFERENCE_SCALES.room);
    expect(renderer.toneMappingExposure).toBe(DEFAULT_RIG.exposure);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      '[archviz] sky environment failed; using the room fallback', error);
    lighting.dispose();
    expect(fallback.dispose).toHaveBeenCalledTimes(1);
  });

  it('propagates the original room error when the fallback also fails', async () => {
    const error = { reason: 'room failed' };
    factories.procedural.mockRejectedValue(new Error('sky failed'));
    factories.room.mockRejectedValue(error);
    await expect(composeLighting({
      scene: new Scene(), renderer: { shadowMap: {} } as WebGPURenderer, panelRoot: null,
      shadowMapSize: 512, sunShadow: false, onChange: vi.fn(),
    })).rejects.toBe(error);
    expect(factories.room).toHaveBeenCalledTimes(1);
  });
});
