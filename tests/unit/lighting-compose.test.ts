// Shadow assignment must keep transmissive dome panes out of the sun shadow map.

import {
  DataTexture,
  EquirectangularReflectionMapping,
  FloatType,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  WebGLRenderTarget,
} from 'three';
import { describe, expect, it } from 'vitest';

import { enableShadows } from '../../src/lighting/compose';

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
    // HDRLoader's flipY = true is what turns its top-down scanlines upright. Clearing it (177c727)
    // put the field overhead and tinted the room olive.
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
  ): { up: number; side: number } {
    const luma = (i: number): number =>
      0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    let up = 0;
    let side = 0;
    for (let y = 0; y < height; y += 1) {
      const row = rowZeroIsZenith ? y : height - 1 - y;
      const theta = ((row + 0.5) / height) * Math.PI;
      const dOmega = (Math.PI / height) * ((2 * Math.PI) / width) * Math.sin(theta);
      for (let x = 0; x < width; x += 1) {
        const phi = ((x + 0.5) / width) * 2 * Math.PI;
        const dx = Math.sin(theta) * Math.cos(phi);
        const dz = Math.sin(theta) * Math.sin(phi);
        const value = luma(4 * (y * width + x)) * dOmega;
        up += value * Math.max(0, Math.cos(theta));
        const facing = Math.max(0, dx) + Math.max(0, -dx) + Math.max(0, dz) + Math.max(0, -dz);
        side += (value * facing) / 4;
      }
    }
    return { up, side };
  }

  it('matches the upright, clamped School Field HDR fill within 10 percent, up and sideways', async () => {
    const { readFileSync } = await import('node:fs');
    const { FloatType: Float } = await import('three');
    const { HDRLoader } = await import('three/addons/loaders/HDRLoader.js');
    const { HDR_ENVIRONMENT_SCALE, PROCEDURAL_ENVIRONMENT_SCALE } = await import(
      '../../src/lighting/compose'
    );
    const sky = await import('../../src/lighting/sky');

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
    const before = irradiance(received, width, height, true);
    const after = irradiance(
      sky.gradientSkyPixels(sky.environmentSkyPalette()),
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
    const skyPixels = sky.gradientSkyPixels(sky.environmentSkyPalette());
    const bandRatio =
      (bandMean(skyPixels, sky.SKY_WIDTH, sky.SKY_HEIGHT, false) * PROCEDURAL_ENVIRONMENT_SCALE) /
      (bandMean(received, width, height, true) * HDR_ENVIRONMENT_SCALE);
    expect(bandRatio).toBeCloseTo(1.4, 1);
  });
});
