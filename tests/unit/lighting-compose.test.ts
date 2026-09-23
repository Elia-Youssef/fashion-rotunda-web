// Shadow assignment must keep transmissive dome panes out of the sun shadow map.

import { Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial } from 'three';
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
