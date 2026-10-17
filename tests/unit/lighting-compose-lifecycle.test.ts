// The lighting composition with every seam mocked: boot and rig routing, the panel, sky
// selection, and one dispose taking the whole rig down.

import { Group, Scene, Texture } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  composeLighting,
  PROCEDURAL_ENVIRONMENT_SCALE,
} from '../../src/lighting/compose';
import type { Lighting, LightingOptions } from '../../src/lighting/compose';
import {
  DEFAULT_RIG,
  daylightParameters,
  serializeRig,
  updateDaylight,
  updateExposure,
} from '../../src/lighting/rig';

const composeMocks = vi.hoisted(() => ({
  procedural: vi.fn(),
  hdr: vi.fn(),
  room: vi.fn(),
  registerRectAreaLights: vi.fn(),
  createThreeRig: vi.fn(),
  mountLightPanel: vi.fn(),
}));

// Only the three environment factories are seams for the composition tests below; every other
// export stays the real module.
vi.mock('../../src/lighting/environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lighting/environment')>()),
  createProceduralEnvironment: composeMocks.procedural,
  createHdrEnvironment: composeMocks.hdr,
  createRoomEnvironment: composeMocks.room,
}));
vi.mock('../../src/lighting/rect-area-ltc', () => ({
  registerRectAreaLights: composeMocks.registerRectAreaLights,
}));
vi.mock('../../src/lighting/three-rig', () => ({
  createThreeRig: composeMocks.createThreeRig,
}));
vi.mock('../../src/ui/lightpanel', () => ({
  mountLightPanel: composeMocks.mountLightPanel,
}));

interface ComposeHarness {
  lighting: Lighting;
  scene: Scene;
  renderer: { shadowMap: { enabled: boolean }; toneMappingExposure: number };
  onChange: ReturnType<typeof vi.fn>;
  panelRoot: HTMLElement | null;
  threeRig: { group: Group; apply: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  panel: { setRig: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  environment: {
    texture: Texture;
    apply: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  };
}

function stubEnvironment(): ComposeHarness['environment'] {
  const texture = new Texture();
  return {
    texture,
    apply: vi.fn((scene: Scene, intensity: number, backgroundIntensity: number) => {
      scene.environment = texture;
      scene.environmentIntensity = intensity;
      scene.backgroundIntensity = backgroundIntensity;
    }),
    dispose: vi.fn(),
  };
}

async function mountCompose(overrides: Partial<LightingOptions> = {}): Promise<ComposeHarness> {
  const scene = new Scene();
  const renderer = { shadowMap: { enabled: false }, toneMappingExposure: 0 };
  const onChange = vi.fn();
  const environment = stubEnvironment();
  composeMocks.procedural.mockResolvedValue(environment);
  const threeRig = { group: new Group(), apply: vi.fn(), dispose: vi.fn() };
  composeMocks.createThreeRig.mockImplementation(() => threeRig);
  const panel = { setRig: vi.fn(), dispose: vi.fn() };
  composeMocks.mountLightPanel.mockReturnValue(panel);
  const panelRoot = {} as HTMLElement;
  const lighting = await composeLighting({
    renderer: renderer as unknown as WebGPURenderer,
    scene,
    panelRoot,
    shadowMapSize: 2048,
    sunShadow: true,
    onChange,
    ...overrides,
  });
  return { lighting, scene, renderer, onChange, panelRoot, threeRig, panel, environment };
}

describe('composeLighting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes the sun shadow to the renderer shadow map and the rig options to the three rig', async () => {
    const on = await mountCompose({ shadowMapSize: 2048, sunShadow: true });
    expect(on.renderer.shadowMap.enabled).toBe(true);
    expect(composeMocks.createThreeRig).toHaveBeenCalledWith(DEFAULT_RIG, {
      shadowMapSize: 2048,
      sunShadow: true,
    });

    const off = await mountCompose({ sunShadow: false });
    expect(off.renderer.shadowMap.enabled).toBe(false);
    expect(composeMocks.createThreeRig).toHaveBeenLastCalledWith(DEFAULT_RIG, {
      shadowMapSize: 2048,
      sunShadow: false,
    });
  });

  it('registers the rect-area lights, adds the studio rig to the scene and takes everything down on dispose', async () => {
    const h = await mountCompose();
    expect(composeMocks.registerRectAreaLights).toHaveBeenCalledTimes(1);
    expect(h.threeRig.group.parent).toBe(h.scene);

    h.lighting.dispose();

    expect(h.threeRig.group.parent).toBeNull();
    expect(h.panel.dispose).toHaveBeenCalledTimes(1);
    expect(h.threeRig.dispose).toHaveBeenCalledTimes(1);
    expect(h.environment.dispose).toHaveBeenCalledTimes(1);
  });

  it('applies a whole rig to the three rig, the environment, the exposure, the panel and the loop', async () => {
    const h = await mountCompose();
    expect(h.onChange).toHaveBeenCalledTimes(1);
    const boot = daylightParameters(DEFAULT_RIG.daylight);
    expect(h.environment.apply).toHaveBeenCalledTimes(1);
    expect(h.environment.apply).toHaveBeenCalledWith(
      h.scene, boot.skyIntensity * PROCEDURAL_ENVIRONMENT_SCALE, boot.backgroundIntensity,
    );
    expect(h.renderer.toneMappingExposure).toBe(DEFAULT_RIG.exposure);

    const next = updateExposure(updateDaylight(DEFAULT_RIG, 1), 2);
    h.lighting.apply(next);

    const params = daylightParameters(next.daylight);
    expect(h.threeRig.apply).toHaveBeenCalledWith(next);
    expect(h.environment.apply).toHaveBeenLastCalledWith(
      h.scene, params.skyIntensity * PROCEDURAL_ENVIRONMENT_SCALE, params.backgroundIntensity,
    );
    expect(h.renderer.toneMappingExposure).toBe(next.exposure);
    expect(h.panel.setRig).toHaveBeenCalledTimes(1);
    expect(h.panel.setRig).toHaveBeenCalledWith(next);
    expect(h.onChange).toHaveBeenCalledTimes(2);
    expect(h.lighting.rig).toBe(next);
    expect(h.lighting.serialize()).toBe(serializeRig(next));
  });

  it('mounts the panel with the boot rig and routes panel edits through the composition', async () => {
    const custom = updateExposure(updateDaylight(DEFAULT_RIG, 0.75), 1.5);
    const h = await mountCompose({ initial: serializeRig(custom) });
    expect(composeMocks.mountLightPanel).toHaveBeenCalledTimes(1);
    const [panelRoot, panelOptions] = composeMocks.mountLightPanel.mock.calls[0];
    expect(panelRoot).toBe(h.panelRoot);
    expect(panelOptions.rig).toEqual(custom);
    expect(panelOptions.rig).not.toBe(DEFAULT_RIG);
    expect(h.lighting.rig).toEqual(custom);

    panelOptions.onChange(custom);
    expect(h.renderer.toneMappingExposure).toBe(custom.exposure);
    const params = daylightParameters(custom.daylight);
    expect(h.environment.apply).toHaveBeenLastCalledWith(
      h.scene, params.skyIntensity * PROCEDURAL_ENVIRONMENT_SCALE, params.backgroundIntensity,
    );
    expect(h.lighting.rig).toBe(custom);
    expect(h.panel.setRig).not.toHaveBeenCalled();
  });

  it('keeps the composition working when no panel is mounted', async () => {
    const h = await mountCompose({ panelRoot: null });
    expect(composeMocks.mountLightPanel).not.toHaveBeenCalled();
    h.lighting.apply(updateDaylight(DEFAULT_RIG, 1));
    h.lighting.dispose();
    expect(h.onChange).toHaveBeenCalledTimes(2);
    expect(h.environment.dispose).toHaveBeenCalledTimes(1);
  });

  it('selects the procedural sky when the hdr param is chosen without a url', async () => {
    const h = await mountCompose({ sky: 'hdr' });
    expect(composeMocks.procedural).toHaveBeenCalledTimes(1);
    expect(composeMocks.procedural).toHaveBeenLastCalledWith(h.renderer, DEFAULT_RIG.daylight);
    expect(composeMocks.hdr).not.toHaveBeenCalled();
    expect(composeMocks.room).not.toHaveBeenCalled();
    const boot = daylightParameters(DEFAULT_RIG.daylight);
    expect(h.scene.environmentIntensity).toBe(boot.skyIntensity * PROCEDURAL_ENVIRONMENT_SCALE);
  });
});
