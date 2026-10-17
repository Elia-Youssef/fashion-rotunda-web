// Shadow assignment must keep transmissive dome panes out of the sun shadow map.

import {
  DataTexture,
  EquirectangularReflectionMapping,
  FloatType,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Scene,
  Texture,
  WebGLRenderTarget,
} from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  composeLighting,
  enableShadows,
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
// export the suites above import dynamically (fromRenderTarget, createSkyOnlyBackground,
// orientHdrEquirectangular) stays the real module.
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

describe('enableShadows', () => {
  it('lets a transmission-only material receive the sun without casting a black pane shadow', () => {
    const root = new Group();
    const glass = new MeshPhysicalMaterial({ transmission: 1 });
    glass.transparent = false;
    const domePane = new Mesh(undefined, glass);
    const marble = new Mesh(undefined, new MeshStandardMaterial());
    root.add(domePane, marble);

    enableShadows(root);

    expect(domePane.castShadow).toBe(false);
    expect(domePane.receiveShadow).toBe(true);
    expect(marble.castShadow).toBe(true);
    expect(marble.receiveShadow).toBe(true);
  });

  it('treats a mesh with no material as opaque and still gives it the sun shadow', () => {
    const mesh = { isMesh: true, castShadow: false, receiveShadow: false, material: null };
    enableShadows({ traverse: (callback) => callback(mesh) });

    expect(mesh.castShadow).toBe(true);
    expect(mesh.receiveShadow).toBe(true);
  });

  it('leaves a mesh that lacks the shadow properties untouched', () => {
    const bare = { isMesh: true, castShadow: false, receiveShadow: false };
    enableShadows({ traverse: (callback) => callback(bare) });

    expect(bare.castShadow).toBe(false);
    expect(bare.receiveShadow).toBe(false);
  });

  it('never casts from a material group that contains any transparent material', () => {
    const transmissive = new MeshPhysicalMaterial({ transmission: 1 });
    transmissive.transparent = false;
    const mixed = new Mesh(undefined, [new MeshStandardMaterial(), transmissive]);
    const solid = new Mesh(undefined, [new MeshStandardMaterial(), new MeshStandardMaterial()]);
    enableShadows({ traverse: (callback) => { callback(mixed); callback(solid); } });

    expect(mixed.castShadow).toBe(false);
    expect(mixed.receiveShadow).toBe(true);
    expect(solid.castShadow).toBe(true);
    expect(solid.receiveShadow).toBe(true);
  });
});

describe('Environment application stability', () => {
  it('assigns the same environment and background texture references across repeated apply calls', async () => {
    const { fromRenderTarget } = await import('../../src/lighting/environment');
    const { Scene, Texture, WebGLRenderTarget } = await import('three');

    const stubTarget = new WebGLRenderTarget(16, 16);
    const stubBackground = new Texture();
    const env = fromRenderTarget(stubTarget, stubBackground);

    const scene = new Scene();

    // First apply (e.g. default daylight)
    env.apply(scene, 0.4, 0.25);
    const envTextureFirst = scene.environment;
    const bgTextureFirst = scene.background;
    expect(scene.environmentIntensity).toBe(0.4);
    expect(scene.backgroundIntensity).toBe(0.25);

    // Second apply with changed intensities (e.g. maximum daylight)
    env.apply(scene, 0.52, 0.3);
    expect(scene.environment).toBe(envTextureFirst);
    expect(scene.background).toBe(bgTextureFirst);
    expect(scene.environmentIntensity).toBe(0.52);
    expect(scene.backgroundIntensity).toBe(0.3);

    // Repeated updates never reallocate or replace textures
    env.apply(scene, 0.2, 0.15);
    expect(scene.environment).toBe(envTextureFirst);
    expect(scene.background).toBe(bgTextureFirst);

    stubTarget.dispose();
    stubBackground.dispose();
  });
});

describe('visible HDR background', () => {
  it('keeps the upper source sky and remaps the lower field to its clean sky band', async () => {
    const { createSkyOnlyBackground } = await import('../../src/lighting/environment');
    const width = 512;
    const height = 11;
    const pixels = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = 4 * (y * width + x);
        pixels[pixel] = y;
        pixels[pixel + 1] = y + 0.25;
        pixels[pixel + 2] = y + 0.5;
        pixels[pixel + 3] = 1;
      }
    }
    const source = new DataTexture(pixels, width, height, undefined, FloatType);
    source.mapping = EquirectangularReflectionMapping;
    // As HDRLoader delivers it and orientHdrEquirectangular keeps it: sky scanlines first, flipY true.
    source.flipY = true;

    const background = createSkyOnlyBackground(source) as DataTexture;
    const visiblePixels = background.image.data as Float32Array;

    // The zenith is untouched; the final row reads from source row 2.45 rather than row 10.
    expect(visiblePixels[0]).toBe(0);
    expect(visiblePixels[4 * (2 * width)]).toBe(2);
    expect(visiblePixels[4 * ((height - 1) * width)]).toBeCloseTo(2.45, 6);
    expect(pixels[4 * ((height - 1) * width)]).toBe(10);
    expect(background.mapping).toBe(EquirectangularReflectionMapping);
    // The copy must upload the same way as its source, or its sky rows would land at the nadir.
    expect(background.flipY).toBe(true);

    source.dispose();
    background.dispose();
  });

  it('disposes both HDR inputs after their PMREM environment is released', async () => {
    const { fromRenderTarget } = await import('../../src/lighting/environment');
    const target = new WebGLRenderTarget(16, 16);
    const source = new DataTexture(new Float32Array(16), 2, 2, undefined, FloatType);
    const background = new DataTexture(new Float32Array(16), 2, 2, undefined, FloatType);
    let sourceDisposals = 0;
    let backgroundDisposals = 0;
    source.addEventListener('dispose', () => { sourceDisposals += 1; });
    background.addEventListener('dispose', () => { backgroundDisposals += 1; });

    fromRenderTarget(target, background, source).dispose();

    expect(backgroundDisposals).toBe(1);
    expect(sourceDisposals).toBe(1);
  });
});

describe('HDR equirectangular orientation', () => {
  it('keeps the loader vertical flip, so the first (sky) scanline uploads at the zenith', async () => {
    // Both backends put the first uploaded row at v = 0, which equirectUV maps to straight down;
    // HDRLoader's flipY = true is what turns its top-down scanlines upright. Clearing it (the
    // 2026-09-23 integration) put the field overhead and tinted the room olive.
    const { orientHdrEquirectangular } = await import('../../src/lighting/environment');
    const { EquirectangularReflectionMapping, Texture } = await import('three');

    const source = new Texture();
    source.flipY = true;

    orientHdrEquirectangular(source);

    expect(source.mapping).toBe(EquirectangularReflectionMapping);
    expect(source.flipY).toBe(true);
  });
});

describe('procedural sky calibration', () => {
  // The same cosine-weighted integral as the sky calibration, for an up normal and the mean of four
  // horizontal normals. The HDR's
  // scanlines run from the zenith down; the procedural pixels run from the nadir up (sky.ts).
  function irradiance(
    data: Float32Array,
    width: number,
    height: number,
    rowZeroIsZenith: boolean,
    normal: [number, number, number] = [0, 1, 0],
  ): { up: number; side: number; directional: number } {
    const luma = (i: number): number =>
      0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    let up = 0;
    let side = 0;
    let directional = 0;
    for (let y = 0; y < height; y += 1) {
      const row = rowZeroIsZenith ? y : height - 1 - y;
      const theta = ((row + 0.5) / height) * Math.PI;
      const dOmega = (Math.PI / height) * ((2 * Math.PI) / width) * Math.sin(theta);
      for (let x = 0; x < width; x += 1) {
        const phi = ((x + 0.5) / width) * 2 * Math.PI;
        const dx = Math.sin(theta) * Math.cos(phi);
        const dz = Math.sin(theta) * Math.sin(phi);
        const value = luma(4 * (y * width + x)) * dOmega;
        // EquirectUV's world azimuth is phi - pi, whereas the four-side mean is invariant to this shift.
        directional += value * Math.max(0, -dx * normal[0] + Math.cos(theta) * normal[1] - dz * normal[2]);
        up += value * Math.max(0, Math.cos(theta));
        const facing = Math.max(0, dx) + Math.max(0, -dx) + Math.max(0, dz) + Math.max(0, -dz);
        side += (value * facing) / 4;
      }
    }
    return { up, side, directional };
  }

  async function referenceHdr() {
    const { readFileSync } = await import('node:fs');
    const { FloatType: Float } = await import('three');
    const { HDRLoader } = await import('three/addons/loaders/HDRLoader.js');
    const file = readFileSync(
      new URL('../../public/content/env/school-field-cloudy-1k.hdr', import.meta.url),
    );
    const loader = new HDRLoader();
    loader.setDataType(Float);
    const hdr = loader.parse(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
    const { width, height } = hdr;
    if (width === undefined || height === undefined) throw new Error('the HDR parsed without a size');
    // The runtime loads half floats, and HDRLoader clamps each channel to the float16 maximum.
    const received = Float32Array.from(hdr.data as Float32Array, (value) => Math.min(value, 65504));
    return { received, width, height };
  }

  it('matches the upright, clamped School Field HDR fill within 10 percent, up and sideways', async () => {
    const { HDR_ENVIRONMENT_SCALE, PROCEDURAL_ENVIRONMENT_SCALE } = await import('../../src/lighting/compose');
    const sky = await import('../../src/lighting/sky');
    const { received, width, height } = await referenceHdr();
    const before = irradiance(received, width, height, true);
    const after = irradiance(
      sky.gradientSkyPixels(sky.baseEnvironmentSkyPalette()),
      sky.SKY_WIDTH,
      sky.SKY_HEIGHT,
      false,
    );

    const upRatio = (after.up * PROCEDURAL_ENVIRONMENT_SCALE) / (before.up * HDR_ENVIRONMENT_SCALE);
    const sideRatio =
      (after.side * PROCEDURAL_ENVIRONMENT_SCALE) / (before.side * HDR_ENVIRONMENT_SCALE);
    expect(Math.abs(upRatio - 1)).toBeLessThan(0.1);
    expect(Math.abs(sideRatio - 1)).toBeLessThan(0.1);
    // The adopted calibration (calibration.json, "shipped"): up 0.939, side 0.924.
    expect(upRatio).toBeCloseTo(0.939, 2);
    expect(sideRatio).toBeCloseTo(0.924, 2);

    // Third target: the 0 to 15 degree band a glossy floor mirrors, 1.400 of the HDR's.
    const bandMean = (data: Float32Array, w: number, h: number, rowZeroIsZenith: boolean): number => {
      let sum = 0;
      let weight = 0;
      for (let y = 0; y < h; y += 1) {
        const row = rowZeroIsZenith ? y : h - 1 - y;
        const theta = ((row + 0.5) / h) * Math.PI;
        const elevation = 90 - (theta * 180) / Math.PI;
        if (elevation < 0 || elevation >= 15) continue;
        for (let x = 0; x < w; x += 1) {
          const i = 4 * (y * w + x);
          sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) * Math.sin(theta);
          weight += Math.sin(theta);
        }
      }
      return sum / weight;
    };
    const skyPixels = sky.gradientSkyPixels(sky.baseEnvironmentSkyPalette());
    const bandRatio =
      (bandMean(skyPixels, sky.SKY_WIDTH, sky.SKY_HEIGHT, false) * PROCEDURAL_ENVIRONMENT_SCALE) /
      (bandMean(received, width, height, true) * HDR_ENVIRONMENT_SCALE);
    expect(bandRatio).toBeCloseTo(1.4, 1);
  });

  it("pins the owner's 2026-10-14 C3 bounce choice separately from the base calibration", async () => {
    const { HDR_ENVIRONMENT_SCALE, PROCEDURAL_ENVIRONMENT_SCALE } = await import('../../src/lighting/compose');
    const sky = await import('../../src/lighting/sky');
    const { received, width, height } = await referenceHdr();
    const hdr = irradiance(received, width, height, true);
    const basePixels = sky.gradientSkyPixels(sky.baseEnvironmentSkyPalette());
    const shippedPixels = sky.gradientSkyPixels(sky.environmentSkyPalette());
    const base = irradiance(basePixels, sky.SKY_WIDTH, sky.SKY_HEIGHT, false);
    const shipped = irradiance(shippedPixels, sky.SKY_WIDTH, sky.SKY_HEIGHT, false);
    const sideRatio = shipped.side * PROCEDURAL_ENVIRONMENT_SCALE / (hdr.side * HDR_ENVIRONMENT_SCALE);
    const upRatio = shipped.up * PROCEDURAL_ENVIRONMENT_SCALE / (hdr.up * HDR_ENVIRONMENT_SCALE);
    expect(sideRatio).toBeCloseTo(1.1132086754, 8);
    expect(shipped.side).toBeGreaterThan(base.side);

    // A wall normal toward the sun's antipode must receive more added fill than its opposite.
    const [x, , z] = daylightParameters(0.5).direction;
    const horizontal = Math.hypot(x, z);
    const away: [number, number, number] = [x / horizontal, 0, z / horizontal];
    const toward: [number, number, number] = [-away[0], 0, -away[2]];
    const increase = (normal: [number, number, number]): number =>
      irradiance(shippedPixels, sky.SKY_WIDTH, sky.SKY_HEIGHT, false, normal).directional -
      irradiance(basePixels, sky.SKY_WIDTH, sky.SKY_HEIGHT, false, normal).directional;
    expect(increase(away)).toBeGreaterThan(increase(toward));
    expect(increase(away)).toBeGreaterThan(0);
    expect(Math.abs(upRatio - 1)).toBeLessThan(0.1);
  });
});

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
