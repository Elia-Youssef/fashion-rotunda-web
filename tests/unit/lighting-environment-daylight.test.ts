import { describe, expect, it, vi } from 'vitest';
import { expectReleasedOnce, renderer, specs, state } from '../support/lighting-environment';
import { createHash } from 'node:crypto';
// @ts-expect-error The internal cache predicate has no published declaration.
import NodeManager from 'three/src/renderers/common/nodes/NodeManager.js';
// @ts-expect-error The internal render-object predicate has no published declaration.
import RenderObject from 'three/src/renderers/common/RenderObject.js';
import type { WebGPURenderer } from 'three/webgpu';
import { Scene } from 'three';
import { createProceduralEnvironment } from '../../src/lighting/environment';
import { createGradientSkyTexture, environmentSkyPalette, visibleSkyPalette } from '../../src/lighting/sky';

// The Daylight control's contract on the procedural environment: boot palettes, texture
// replacement and reuse across slider moves, live render-object invalidation, and recovery
// from a failed update.

describe('procedural daylight updates', () => {
  it.each([undefined, 0.5])('boots at default %s with the original palette bytes', async (initial) => {
    state.capturePixels = true;
    const environment = await createProceduralEnvironment(renderer as unknown as WebGPURenderer, initial);
    expect(createGradientSkyTexture).toHaveBeenNthCalledWith(1, environmentSkyPalette(), 'procedural sky lighting');
    expect(createGradientSkyTexture).toHaveBeenNthCalledWith(2, visibleSkyPalette(), 'procedural sky visible');
    for (const [name, digest] of [
      ['source', '5c22892497aed78426940972524a2559135030592be30c39f4b8787be95d5eb3'],
      ['background', '9b30a460a8eddac24a9d0cec815199d4480784ed625f78683c9f9969202ad07a'],
    ]) {
      const texture = state.resources.find((entry) => entry.name === name)!.resource as import('three').DataTexture;
      const pixels = texture.image.data as Uint16Array;
      expect(createHash('sha256').update(Buffer.from(pixels.buffer)).digest('hex')).toBe(digest);
    }
    environment.updateDaylight!(0.5);
    expect(createGradientSkyTexture).toHaveBeenCalledTimes(2);
    environment.dispose();
    expectReleasedOnce();
  });

  it.each([0, 0.25])('boots directly at Dawn value %s without constructing Day first', async (initial) => {
    const environment = await createProceduralEnvironment(renderer as unknown as WebGPURenderer, initial);
    expect(createGradientSkyTexture).toHaveBeenNthCalledWith(1, environmentSkyPalette(initial), 'procedural sky lighting');
    expect(createGradientSkyTexture).toHaveBeenNthCalledWith(2, visibleSkyPalette(initial), 'procedural sky visible');
    environment.updateDaylight!(initial);
    expect(createGradientSkyTexture).toHaveBeenCalledTimes(2);
    environment.dispose();
    expectReleasedOnce();
  });

  it('releases every replaced texture and target once across many slider changes', async () => {
    const environment = await createProceduralEnvironment(renderer as unknown as WebGPURenderer);
    const scene = new Scene();
    let previous = environment.texture;
    for (let step = 0; step < 101; step += 1) {
      const daylight = step / 100;
      environment.updateDaylight!(daylight);
      if (daylight <= 0.5) expect(environment.texture).not.toBe(previous);
      else expect(environment.texture).toBe(previous);
      environment.apply(scene, 0.4, 0.25);
      expect(scene.environment).toBe(environment.texture);
      expect(scene.background).toBe(state.resources.at(-3)!.resource);
      expect(createGradientSkyTexture).toHaveBeenLastCalledWith(visibleSkyPalette(daylight), 'procedural sky visible');
      expect(createGradientSkyTexture).toHaveBeenNthCalledWith(
        2 * (Math.min(step, 50) + 1) + 1, environmentSkyPalette(daylight), 'procedural sky lighting');
      const live = state.resources.filter(({ resource }) => vi.mocked(resource.dispose).mock.calls.length === 0);
      // Identify the current generation, not merely two resources with the right labels.
      expect(live).toHaveLength(2);
      expect(live[0].resource).toBe(scene.background);
      expect(live[1].resource).toBe(state.output);
      expect(scene.environment).toBe(state.output!.texture);
      for (const { resource } of state.resources) {
        expect(vi.mocked(resource.dispose).mock.calls.length).toBeLessThanOrEqual(1);
      }
      previous = environment.texture;
    }
    environment.dispose();
    environment.dispose();
    const acquisitions = state.resources.length;
    environment.updateDaylight!(0.25);
    expect(state.resources).toHaveLength(acquisitions);
    expectReleasedOnce();
  });

  it('reuses texture objects and performs no construction for unchanged daylight', async () => {
    const environment = await createProceduralEnvironment(renderer as unknown as WebGPURenderer);
    const texture = environment.texture;
    const acquired = state.resources.length;
    for (let frame = 0; frame < 100; frame += 1) {
      environment.updateDaylight!(0.5);
      environment.apply(new Scene(), 0.4, 0.25);
    }
    environment.updateDaylight!(Number.NaN);
    for (let step = 51; step <= 100; step += 1) environment.updateDaylight!(step / 100);
    environment.updateDaylight!(Infinity);
    expect(state.resources).toHaveLength(acquired);
    expect(environment.texture).toBe(texture);
    environment.dispose();
    expectReleasedOnce();
  });

  it.each([1, 2, 3])('counts real render-object update predicates per palette step, run %s', async (run) => {
    const actual = await vi.importActual<typeof import('three')>('three');
    const scene = new actual.Scene();
    const material = new actual.MeshStandardMaterial();
    const mesh = new actual.Mesh(new actual.BufferGeometry(), material);
    const camera = new actual.PerspectiveCamera();
    const offlineRenderer = {
      info: { calls: 0 }, lighting: { enabled: true }, shadowMap: { enabled: false, type: 0 },
      getOutputRenderTarget: () => null, contextNode: { id: 1, version: 0 },
      backend: { isWebGPUBackend: true }, _currentSourceMaterial: null,
    };
    const nodes = new NodeManager(offlineRenderer, offlineRenderer.backend);
    const environment = await createProceduralEnvironment(renderer as unknown as WebGPURenderer);
    environment.apply(scene, 0.4, 0.25);
    const object = new RenderObject(nodes, {}, offlineRenderer, mesh, material, scene, camera,
      { getCacheKey: () => 1 }, { id: 1 }, null);
    object.onDispose = () => {};
    const versions = material.version;
    const counts = { run, noon: [] as number[], dawn: [] as number[], materialVersionChanges: 0 };
    for (const direction of ['noon', 'dawn'] as const) {
      for (let step = 1; step <= 20; step += 1) {
        environment.updateDaylight!(0.5 + (direction === 'noon' ? 1 : -1) * step / 40);
        environment.apply(scene, 0.4, 0.25);
        offlineRenderer.info.calls += 1;
        const invalidation = Number(object.needsUpdate);
        counts[direction].push(invalidation);
        expect(invalidation).toBe(direction === 'noon' ? 0 : 1);
        // Establish the cache baseline that a refreshed render object would have on the next draw.
        object.initialNodesCacheKey = object.getDynamicCacheKey();
      }
    }
    counts.materialVersionChanges = material.version - versions;
    expect(counts.materialVersionChanges).toBe(0);
    console.info('Daylight render-object update counts:', JSON.stringify(counts));
    object.dispose();
    environment.dispose();
    mesh.geometry.dispose();
    material.dispose();
    expectReleasedOnce();
  });

  it.each(specs[1].failures.filter(([phase]) => phase !== 'init'))(
    'keeps the previous environment live after a failed %s update and permits retry', async (phase) => {
      const environment = await createProceduralEnvironment(renderer as unknown as WebGPURenderer);
      const scene = new Scene();
      environment.apply(scene, 0.4, 0.25);
      const texture = scene.environment;
      const background = scene.background;
      const previous = state.resources.slice();
      const acquired = previous.length;
      state.converted = false;
      state.fail = phase;
      expect(() => environment.updateDaylight!(0)).toThrow(state.error);
      expect(environment.texture).toBe(texture);
      environment.apply(scene, 0.4, 0.25);
      expect(scene.environment).toBe(texture);
      expect(scene.background).toBe(background);
      for (const { name, resource } of previous) {
        expect(resource.dispose).toHaveBeenCalledTimes(name === 'background' || name === 'target' ? 0 : 1);
      }
      for (const { resource } of state.resources.slice(acquired)) expect(resource.dispose).toHaveBeenCalledTimes(1);
      state.fail = '';
      environment.updateDaylight!(0);
      expect(environment.texture).not.toBe(texture);
      environment.dispose();
      expectReleasedOnce();
    },
  );
});
