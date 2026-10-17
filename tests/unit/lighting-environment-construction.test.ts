import { describe, expect, it } from 'vitest';
import { renderer, state } from '../support/lighting-environment';
import type { WebGPURenderer } from 'three/webgpu';
import { DataTexture, FloatType, RenderTarget, Scene } from 'three';
import {
  createHdrEnvironment,
  createProceduralEnvironment,
  createRoomEnvironment,
  fromRenderTarget,
} from '../../src/lighting/environment';
import { environmentSkyPalette, visibleSkyPalette } from '../../src/lighting/sky';

// What each factory promises on success: the PMREM dimensions and formats, which copy feeds the
// prefilter, the palettes behind the two procedural copies, the default apply intensities and
// the shared-texture release rule.

describe('environment construction contracts', () => {
  it('rounds a non-power-of-two panorama quarter down to the PMREM cube size', async () => {
    state.hdrWidth = 600;
    state.hdrHeight = 300;
    const environment = await createHdrEnvironment(renderer as unknown as WebGPURenderer, '/sky.hdr');
    expect(state.output!.width).toBe(384);
    expect(state.output!.height).toBe(512);
    environment.dispose();
  });

  it('prefilters the procedural lighting copy, not the visible background', async () => {
    const environment = await createProceduralEnvironment(renderer as unknown as WebGPURenderer);
    const source = state.resources.find((entry) => entry.name === 'source')?.resource;
    expect(state.input).toBe(source);
    environment.dispose();
  });

  it('prefilters the loaded HDR panorama, not the derived visible background', async () => {
    const environment = await createHdrEnvironment(renderer as unknown as WebGPURenderer, '/sky.hdr');
    const source = state.resources.find((entry) => entry.name === 'source')?.resource;
    expect(state.input).toBe(source);
    environment.dispose();
  });

  it('builds the lighting copy from the environment palette and the visible copy from the visible palette', async () => {
    const environment = await createProceduralEnvironment(renderer as unknown as WebGPURenderer);
    environment.dispose();
    const byName = new Map(state.skyPalettes.map((call) => [call.name, call.palette] as const));
    expect(byName.get('procedural sky lighting')).toEqual(environmentSkyPalette());
    expect(byName.get('procedural sky visible')).toEqual(visibleSkyPalette());
  });

  it('applies the documented default background intensity and blur', async () => {
    const environment = await createProceduralEnvironment(renderer as unknown as WebGPURenderer);
    const scene = new Scene();
    environment.apply(scene, 0.4);
    expect(scene.environmentIntensity).toBe(0.4);
    expect(scene.backgroundIntensity).toBe(0.25);
    expect(scene.backgroundBlurriness).toBe(0.08);
    environment.dispose();

    const room = await createRoomEnvironment(renderer as unknown as WebGPURenderer);
    const bare = new Scene();
    room.apply(bare, 0.5);
    expect(bare.background).toBeNull();
    expect(bare.backgroundIntensity).toBe(1);
    expect(bare.backgroundBlurriness).toBe(0);
    room.dispose();
  });

  it('releases a texture used as both background and source exactly once', () => {
    const target = new RenderTarget(16, 16);
    const shared = new DataTexture(new Float32Array(2 * 2 * 4), 2, 2, undefined, FloatType);
    fromRenderTarget(target, shared, shared).dispose();
    expect(shared.dispose).toHaveBeenCalledTimes(1);
    expect(target.dispose).toHaveBeenCalledTimes(1);
  });
});
