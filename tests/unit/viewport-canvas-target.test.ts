// @vitest-environment jsdom
// jsdom only supplies document.createElement('canvas'); the canvas target itself needs no GPU,
// and the same node-environment stubs stand in for the renderer calls updateBefore makes. This
// file covers the reference kind the node-only viewport-texture.test.ts cannot construct: with
// no render target bound, the viewport texture keys its copy on the canvas target and sizes it
// through getDrawingBufferSize, the path that honours the pixel ratio.

import { CanvasTarget, ViewportTextureNode } from 'three/webgpu';
import type { NodeFrame } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';

import { separateViewportTextureSizes } from '../../src/renderer/viewport-texture';

function canvasFrame(target: CanvasTarget): NodeFrame {
  const renderer = {
    getRenderTarget: () => null,
    getCanvasTarget: () => target,
    copyFramebufferToTexture: vi.fn(),
  };
  return { renderer } as unknown as NodeFrame;
}

describe('viewport copy retirement of the canvas target', () => {
  it('sizes the copy by drawing-buffer size and retires it at the target disposal', () => {
    separateViewportTextureSizes();
    const node = new ViewportTextureNode();
    // 320x240 logical at pixel ratio 2: the copy must take the 640x480 drawing-buffer size,
    // not any width and height the canvas target does not even carry.
    const canvasTarget = new CanvasTarget(document.createElement('canvas'));
    canvasTarget.setDrawingBufferSize(320, 240, 2);
    node.updateBefore(canvasFrame(canvasTarget));
    const copy = node.getTextureForReference(canvasTarget);
    expect(copy.image).toMatchObject({ width: 640, height: 480 });

    let disposed = 0;
    copy.addEventListener('dispose', () => {
      disposed += 1;
    });
    canvasTarget.dispose();
    canvasTarget.dispose();

    expect(disposed).toBe(1);
    expect(node.getTextureForReference(canvasTarget)).not.toBe(copy);
  });
});
