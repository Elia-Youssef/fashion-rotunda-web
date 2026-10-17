import { DepthTexture, PerspectiveCamera, RenderTarget, Texture } from 'three/webgpu';
import { convertToTexture, float, texture, vec4 } from 'three/tsl';
import type { NodeFrame, TextureNode } from 'three/webgpu';
import type RTTNode from 'three/src/nodes/utils/RTTNode.js';
import BloomNode from 'three/addons/tsl/display/BloomNode.js';
import DepthOfFieldNode from 'three/addons/tsl/display/DepthOfFieldNode.js';
import Lut3DNode from 'three/addons/tsl/display/Lut3DNode.js';
import SSGINode from 'three/addons/tsl/display/SSGINode.js';
import TRAANode from 'three/addons/tsl/display/TRAANode.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.restoreAllMocks());

describe('three post node compatibility contracts', () => {
  it('exposes the initial TRAA depth texture separately from disposed history targets', () => {
    const input = texture(new Texture());
    const node = new TRAANode(input, input, input, new PerspectiveCamera());
    const previous = (node as unknown as { _previousDepthNode: TextureNode })._previousDepthNode;
    expect(previous.value).toBeInstanceOf(DepthTexture);
    expect(previous.value.image).toMatchObject({ width: 1, height: 1 });
    const dispose = vi.spyOn(previous.value, 'dispose');
    node.dispose();
    expect(dispose).not.toHaveBeenCalled();
    previous.value.dispose();
    input.value.dispose();
  });

  it('resizes SSGI through its overridable setSize before drawing each frame', () => {
    const input = texture(new Texture());
    const node = new SSGINode(input, input, input, new PerspectiveCamera());
    const runtime = node as unknown as {
      setSize(width: number, height: number): void;
      _ssgiRenderTarget: RenderTarget;
    };
    runtime.setSize(80, 40);
    expect([runtime._ssgiRenderTarget.width, runtime._ssgiRenderTarget.height]).toEqual([80, 40]);
    // Stop at setSize, before any GPU draw, but run the real updateBefore dispatch.
    const stop = new Error('size observed');
    const size = vi.spyOn(runtime, 'setSize').mockImplementation(() => { throw stop; });
    const frame = {
      renderer: {
        toneMapping: 0, toneMappingExposure: 1, outputColorSpace: '', autoClear: true,
        getRenderTarget: () => null, getActiveCubeFace: () => 0, getActiveMipmapLevel: () => 0,
        getRenderObjectFunction: () => null, getPixelRatio: () => 1, getMRT: () => null,
        getScissorTest: () => false, setMRT: () => undefined,
        setRenderObjectFunction: () => undefined, setClearColor: () => undefined,
        getClearColor: (color: { set(value: number): unknown }) => color.set(0),
        getClearAlpha: () => 1,
        getDrawingBufferSize: (value: { set(w: number, h: number): unknown }) => value.set(160, 90),
      },
    } as unknown as NodeFrame;
    expect(() => node.updateBefore(frame)).toThrow(stop);
    expect(size).toHaveBeenCalledWith(160, 90);
    node.dispose();
    input.value.dispose();
  });

  it('returns the bloom output texture through getTextureNode', () => {
    const node = new BloomNode(vec4(1));
    const runtime = node as unknown as { getTextureNode(): TextureNode };
    const output = runtime.getTextureNode();
    expect(output.value).toBeInstanceOf(Texture);
    expect(output).toHaveProperty('passNode', node);
    expect(runtime.getTextureNode()).toBe(output);
    node.dispose();
  });

  it('keeps depth of field and LUT output vec4 and resizes the depth of field output', () => {
    const input = texture(new Texture());
    const dof = new DepthOfFieldNode(input, float(1), float(2), float(3), float(1));
    const lut = new Lut3DNode(vec4(1), input, 2, float(1));
    expect(dof.nodeType).toBe('vec4');
    expect(lut.nodeType).toBe('vec4');
    const runtime = dof as unknown as {
      setSize(width: number, height: number): void;
      getTextureNode(): TextureNode;
    };
    runtime.setSize(120, 80);
    expect(runtime.getTextureNode().value.image).toMatchObject({ width: 120, height: 80 });
    dof.dispose();
    lut.dispose();
    input.value.dispose();
  });

  it('identifies owned conversion RTTs and borrows existing texture nodes', () => {
    const converted = convertToTexture(vec4(1)) as RTTNode;
    expect(converted.isRTTNode).toBe(true);
    expect(converted.renderTarget).toBeInstanceOf(RenderTarget);
    const dispose = vi.spyOn(converted.renderTarget!, 'dispose');
    converted.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
    const input = texture(new Texture());
    expect(convertToTexture(input)).toBe(input);
    input.value.dispose();
  });
});
