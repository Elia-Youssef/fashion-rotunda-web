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
    source.flipY = false;

    const background = createSkyOnlyBackground(source) as DataTexture;
    const visiblePixels = background.image.data as Float32Array;

    // The zenith is untouched; the final row reads from source row 2.45 rather than row 10.
    expect(visiblePixels[0]).toBe(0);
    expect(visiblePixels[4 * (2 * width)]).toBe(2);
    expect(visiblePixels[4 * ((height - 1) * width)]).toBeCloseTo(2.45, 6);
    expect(pixels[4 * ((height - 1) * width)]).toBe(10);
    expect(background.mapping).toBe(EquirectangularReflectionMapping);
    expect(background.flipY).toBe(false);

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
  it('uploads the already-upright HDR without the loader vertical flip', async () => {
    const { orientHdrEquirectangular } = await import('../../src/lighting/environment');
    const { EquirectangularReflectionMapping, Texture } = await import('three');

    const source = new Texture();
    source.flipY = true;

    orientHdrEquirectangular(source);

    expect(source.mapping).toBe(EquirectangularReflectionMapping);
    expect(source.flipY).toBe(false);
  });
});
