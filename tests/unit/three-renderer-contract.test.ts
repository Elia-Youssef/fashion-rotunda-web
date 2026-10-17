import {
  CubeUVReflectionMapping, HalfFloatType, LinearFilter, LinearSRGBColorSpace,
  Mesh, MeshStandardMaterial, PMREMGenerator, RenderTarget, TextureSource,
  ViewportTextureNode, WebGPURenderer,
} from 'three/webgpu';
import type { Texture } from 'three/webgpu';
import { screenUV, uniform } from 'three/tsl';
import StandardNodeLibrary from 'three/src/renderers/webgpu/nodes/StandardNodeLibrary.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Construction and CPU bookkeeping only: no renderer is initialized and no context is requested.
function renderer(forceWebGL = false): WebGPURenderer {
  return new WebGPURenderer({ canvas: { width: 1, height: 1 } as HTMLCanvasElement, forceWebGL });
}

afterEach(() => vi.restoreAllMocks());

describe('three renderer compatibility contracts', () => {
  it('keeps viewport copies in the reference base cache with replaceable texture sources', () => {
    const base = new ViewportTextureNode();
    const sampled = base.sample(screenUV);
    const target = new RenderTarget(16, 16);
    const copy = sampled.getTextureForReference(target);
    expect(sampled.referenceNode).toBe(base);
    expect(base.getTextureForReference(target)).toBe(copy);
    const cache = (base as unknown as { _cacheTextures: WeakMap<object, Texture> })._cacheTextures;
    expect(cache).toBeInstanceOf(WeakMap);
    expect(cache.get(target)).toBe(copy);
    copy.source = new TextureSource({ width: 16, height: 16 });
    expect(copy.image).toEqual({ width: 16, height: 16 });
    expect(copy.source).not.toBe(base.value.source);
    expect(cache.delete(target)).toBe(true);
    expect(sampled.getTextureForReference(target)).not.toBe(copy);
    target.dispose();
  });

  it('distinguishes the real backend constructors before initialization', () => {
    const gpu = renderer();
    const gl = renderer(true);
    expect(gpu.backend).toHaveProperty('isWebGPUBackend', true);
    expect('isWebGPUBackend' in gl.backend && gl.backend.isWebGPUBackend === true).toBe(false);
    expect(gl.backend).toHaveProperty('isWebGLBackend', true);
  });

  it('binds the default device loss callback to the renderer loss flag', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const instance = renderer();
    const callback = instance.onDeviceLost;
    expect(callback).toBeTypeOf('function');
    callback.call(instance, {
      api: 'WebGPU', message: 'device lost', reason: 'destroyed', originalEvent: null,
    });
    expect(instance).toHaveProperty('_isDeviceLost', true);
  });

  it('resets frame counts while retaining cumulative calls timestamps and live memory', () => {
    const info = renderer().info;
    expect(info.autoReset).toBe(true);
    info.autoReset = false;
    info.render.calls = 9;
    info.render.timestamp = 2.5;
    info.memory.geometries = 3;
    info.memory.textures = 4;
    info.update(new Mesh(), 12, 2);
    expect(info.render).toMatchObject({ drawCalls: 1, triangles: 8, calls: 9 });
    info.reset();
    expect(info.autoReset).toBe(false);
    expect(info.render).toMatchObject({ drawCalls: 0, triangles: 0, calls: 9, timestamp: 2.5 });
    expect(info.memory).toMatchObject({ geometries: 3, textures: 4 });
  });

  it('publishes resolved GPU durations through the render timestamp field', async () => {
    const instance = renderer();
    const resolveQueriesAsync = vi.fn().mockResolvedValue(3.25);
    // The pool is the GPU boundary; the publishing method is the installed implementation.
    const backend = instance.backend as unknown as { resolveTimestampsAsync(type: string): Promise<number> };
    Object.assign(backend, {
      renderer: instance,
      trackTimestamp: true,
      timestampQueryPool: { render: { resolveQueriesAsync } },
    });
    expect(instance.resolveTimestampsAsync).toBeTypeOf('function');
    await backend.resolveTimestampsAsync('render');
    expect(resolveQueriesAsync).toHaveBeenCalledTimes(1);
    expect(instance.info.render.timestamp).toBe(3.25);
    await backend.resolveTimestampsAsync('render');
    expect(instance.info.render.timestamp).toBe(3.25);
  });

  it('allocates the CubeUV layout and PMREM marker used by supplied environment targets', () => {
    const generator = new PMREMGenerator(renderer());
    const runtime = generator as unknown as {
      _setSizeFromTexture(texture: Texture): void;
      _allocateTarget(depth: boolean): RenderTarget;
    };
    // Small faces exercise the minimum tile strip; non-powers exercise face-size rounding.
    const layouts = [
      { inputWidth: 128, width: 336, height: 128 },
      { inputWidth: 1000, width: 384, height: 512 },
      { inputWidth: 2048, width: 1536, height: 2048 },
    ];
    for (const { inputWidth, width, height } of layouts) {
      const input = new RenderTarget(inputWidth, inputWidth / 2);
      runtime._setSizeFromTexture(input.texture);
      const output = runtime._allocateTarget(false);
      expect([output.width, output.height]).toEqual([width, height]);
      expect(output.texture).toMatchObject({
        isPMREMTexture: true, mapping: CubeUVReflectionMapping, type: HalfFloatType,
        minFilter: LinearFilter, magFilter: LinearFilter, colorSpace: LinearSRGBColorSpace,
        generateMipmaps: false,
      });
      expect(output.depthBuffer).toBe(false);
      output.dispose();
      input.dispose();
    }
    generator.dispose();
  });

  it('carries opacity and alpha test nodes from classic materials into node materials', () => {
    const material = new MeshStandardMaterial();
    const opacityNode = uniform(0.5);
    const alphaTestNode = uniform(0.25);
    Object.assign(material, { opacityNode, alphaTestNode });
    const converted = new StandardNodeLibrary().fromMaterial(material)!;
    expect(converted.opacityNode).toBe(opacityNode);
    expect(converted.alphaTestNode).toBe(alphaTestNode);
    converted.dispose();
    material.dispose();
  });
});
