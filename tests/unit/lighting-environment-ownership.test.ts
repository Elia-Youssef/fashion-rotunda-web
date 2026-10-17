import { describe, expect, it } from 'vitest';
import { expectReleasedOnce, previousTarget, renderer, specs, state } from '../support/lighting-environment';
import type { DataTexture } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import {
  CubeUVReflectionMapping,
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  RGBAFormat,
  Scene,
} from 'three';

// The disposal side of every environment factory: what each construction acquires, what it
// retains on success, what it releases on failure and rollback, and what survives repeated
// disposal, a throwing release or a failed render target restore.

for (const spec of specs) {
  describe(`${spec.name} environment ownership`, () => {
    it('releases retained maps once across repeated disposal even when one release throws', async () => {
      const environment = await spec.build(renderer as unknown as WebGPURenderer);
      const scene = new Scene();
      environment.apply(scene, 0.4);
      state.throwing.add('target');
      environment.dispose();
      environment.dispose();
      expect(scene.environment).toBeNull();
      expect(scene.background).toBeNull();
      expectReleasedOnce();
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(
        '[archviz] environment resource release failed', [state.cleanupError],
      );
    });

    it('detaches only its own maps from every scene before releasing textures', async () => {
      const environment = await spec.build(renderer as unknown as WebGPURenderer);
      const scenes = Array.from({ length: 4 }, () => new Scene());
      const foreign = environment.texture.clone();
      for (const scene of scenes) environment.apply(scene, 0.4);
      environment.apply(scenes[0], 0.6);
      const background = scenes[0].background;
      scenes[1].environment = foreign;
      scenes[2].background = foreign;
      scenes[3].environment = foreign;
      scenes[3].background = foreign;
      const unapplied = new Scene();
      unapplied.environment = environment.texture;
      unapplied.background = background;

      const expectDetached = (): void => {
        expect(scenes.map((scene) => scene.environment)).toEqual([null, foreign, null, foreign]);
        expect(scenes.map((scene) => scene.background)).toEqual([null, null, foreign, foreign]);
        expect(unapplied.environment).toBe(environment.texture);
        expect(unapplied.background).toBe(background);
      };
      state.output!.addEventListener('dispose', expectDetached);
      environment.dispose();
      expectDetached();
      expectReleasedOnce();
      foreign.dispose();
    });

    it.each(spec.failures)('releases exactly the acquired resources after %s and preserves the error', async (phase, names) => {
      state.fail = phase;
      await expect(spec.build(renderer as unknown as WebGPURenderer)).rejects.toBe(state.error);
      expect(state.resources.map((entry) => entry.name)).toEqual(names);
      expectReleasedOnce();
    });

    it('retains the same successful output and releases only the original temporary work', async () => {
      const environment = await spec.build(renderer as unknown as WebGPURenderer);
      expect(state.releases).toEqual(spec.temporary);
      const target = state.output!;
      expect(environment.texture).toBe(target.texture);
      expect(target.width).toBe(spec.width);
      expect(target.height).toBe(spec.height);
      expect(target.depthBuffer).toBe(spec.name === 'room');
      expect(target.texture.type).toBe(HalfFloatType);
      expect(target.texture.format).toBe(RGBAFormat);
      expect(target.texture.colorSpace).toBe(LinearSRGBColorSpace);
      expect(target.texture.mapping).toBe(CubeUVReflectionMapping);
      expect(target.texture.magFilter).toBe(LinearFilter);
      expect(target.texture.minFilter).toBe(LinearFilter);
      expect(target.texture.generateMipmaps).toBe(false);
      expect(target.texture).toHaveProperty('isPMREMTexture', true);
      expect(target.texture.name).toBe('PMREM.cubeUv');
      expect(target.scissorTest).toBe(true);
      const scene = new Scene();
      environment.apply(scene, 0.4, 0.25);
      expect(scene.environment).toBe(target.texture);
      expect(scene.environmentIntensity).toBe(0.4);
      const background = state.resources.find((entry) => entry.name === 'background')?.resource;
      expect(scene.background).toBe(background ?? null);
      if (spec.name === 'room') expect(state.roomBlur).toBe(0.3);
      if (spec.name === 'hdr') {
        expect(state.hdrUrl).toBe('/sky.hdr');
        expect(state.input!.flipY).toBe(true);
        // orientHdrEquirectangular ran before the visible copy was derived, so the copy the
        // visitor sees through the dome carries the equirectangular mapping of its source.
        const visible = background as DataTexture | undefined;
        expect(visible?.mapping).toBe(EquirectangularReflectionMapping);
      }
      for (const { name, resource } of state.resources) {
        expect(resource.dispose).toHaveBeenCalledTimes(spec.retained.some((retained) => retained === name) ? 0 : 1);
      }
      environment.dispose();
      expectReleasedOnce();
      expect(console.warn).not.toHaveBeenCalled();
      expect(renderer.setRenderTarget).not.toHaveBeenCalled();
    });

    it.each(spec.name === 'room' ? ['generator', 'room', 'target'] : ['source', 'background', 'generator', 'target'])(
      'attempts every release when %s disposal throws during rollback', async (name) => {
        state.fail = 'convert';
        state.throwing.add(name);
        await expect(spec.build(renderer as unknown as WebGPURenderer)).rejects.toBe(state.error);
        expectReleasedOnce();
        expect(console.warn).toHaveBeenCalledExactlyOnceWith(
          '[archviz] environment resource release failed', [state.cleanupError],
        );
        expect(renderer.setRenderTarget).toHaveBeenCalledExactlyOnceWith(previousTarget, 2, 1);
        expect(state.boundTarget).toBe(previousTarget);
        expect(state.boundFace).toBe(2);
        expect(state.boundLevel).toBe(1);
        expect(renderer.autoClear).toBe(true);
      },
    );

    it('reports multiple failed releases once and preserves a failed render target restore', async () => {
      state.fail = 'convert';
      state.restoreFails = true;
      for (const name of ['source', 'background', 'generator', 'room', 'target']) state.throwing.add(name);
      await expect(spec.build(renderer as unknown as WebGPURenderer)).rejects.toBe(state.error);
      expectReleasedOnce();
      expect(console.warn).toHaveBeenCalledTimes(2);
      expect(console.warn).toHaveBeenNthCalledWith(1,
        '[archviz] environment render target restore failed', state.restoreError);
      expect(console.warn).toHaveBeenNthCalledWith(2,
        '[archviz] environment resource release failed', state.resources.map(() => state.cleanupError));
    });
  });
}
