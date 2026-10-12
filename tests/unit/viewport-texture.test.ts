// Node environment on purpose: ViewportTextureNode and RenderTarget construct without a GPU, and a stub
// renderer stands in for the three calls updateBefore makes (getRenderTarget, getCanvasTarget and
// copyFramebufferToTexture), so the size bookkeeping is covered without drawing anything.

import { RenderTarget, ViewportTextureNode } from 'three/webgpu';
import type { NodeFrame, Texture } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';

import { separateViewportTextureSizes } from '../../src/renderer/viewport-texture';

function frameFor(target: RenderTarget): NodeFrame {
  const renderer = {
    getRenderTarget: () => target,
    getCanvasTarget: () => null,
    copyFramebufferToTexture: vi.fn(),
  };
  return { renderer } as unknown as NodeFrame;
}

/** One frame of the post chain: the pre-pass draws the glass first, then the scene pass. */
function drawBoth(node: ViewportTextureNode, prePass: RenderTarget, scenePass: RenderTarget): void {
  node.updateBefore(frameFor(prePass));
  node.updateBefore(frameFor(scenePass));
}

// The tests run in order: the first one needs the unpatched prototype.
describe('ViewportTextureNode with two render targets of the same size', () => {
  // If this fails after a three.js upgrade, three now keeps one size per target itself and
  // separateViewportTextureSizes can be removed.
  it('in three 0.186.0 alone, leaves the scene-pass texture at its old size after a resize', () => {
    const node = new ViewportTextureNode();
    const prePass = new RenderTarget(1440, 900);
    const scenePass = new RenderTarget(1440, 900);
    drawBoth(node, prePass, scenePass);
    const sceneTexture = node.getTextureForReference(scenePass);
    const versionBefore = sceneTexture.version;

    prePass.setSize(1224, 765);
    scenePass.setSize(1224, 765);
    drawBoth(node, prePass, scenePass);

    expect(sceneTexture.source).toBe(node.getTextureForReference(prePass).source);
    expect(sceneTexture.version).toBe(versionBefore);
  });

  it('flags every target texture for reallocation when its own target changes size', () => {
    // The first per-target texture is separated in this test, so a deprecated three name used for it
    // (the r186 `Source` alias warns once per page) would show up here.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    separateViewportTextureSizes();
    const node = new ViewportTextureNode();
    const prePass = new RenderTarget(1440, 900);
    const scenePass = new RenderTarget(1440, 900);
    drawBoth(node, prePass, scenePass);
    const preTexture = node.getTextureForReference(prePass);
    const sceneTexture = node.getTextureForReference(scenePass);
    const preVersion = preTexture.version;
    const sceneVersion = sceneTexture.version;

    prePass.setSize(1224, 765);
    scenePass.setSize(1224, 765);
    drawBoth(node, prePass, scenePass);

    expect(sceneTexture.source).not.toBe(preTexture.source);
    expect(preTexture.version).toBeGreaterThan(preVersion);
    expect(sceneTexture.version).toBeGreaterThan(sceneVersion);
    expect(sceneTexture.image).toMatchObject({ width: 1224, height: 765 });
    expect(preTexture.image).toMatchObject({ width: 1224, height: 765 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps one texture per target across frames and leaves the default framebuffer alone', () => {
    separateViewportTextureSizes();
    const node = new ViewportTextureNode();
    const target = new RenderTarget(800, 600);
    node.updateBefore(frameFor(target));
    const first = node.getTextureForReference(target);
    const source = first.source;
    node.updateBefore(frameFor(target));

    expect(node.getTextureForReference(target)).toBe(first);
    expect(first.source).toBe(source);
    expect(node.getTextureForReference(null)).not.toBe(first);
  });
});

// A retired post graph disposes its render targets, and each target's copy must go with it: one
// uploaded framebuffer texture per target otherwise stays cached forever (the renderer's texture
// count grows by that many on every rebuild).
describe('viewport copy retirement', () => {
  function drawnCopy(node: ViewportTextureNode, target: RenderTarget): Texture {
    node.updateBefore(frameFor(target));
    return node.getTextureForReference(target);
  }

  function disposalCounter(texture: Texture): () => number {
    let count = 0;
    texture.addEventListener('dispose', () => {
      count += 1;
    });
    return () => count;
  }

  it('disposes the copy and drops it from the cache when its reference is finally disposed', () => {
    separateViewportTextureSizes();
    const node = new ViewportTextureNode();
    const target = new RenderTarget(640, 480);
    const copy = drawnCopy(node, target);
    const disposed = disposalCounter(copy);

    target.dispose();
    target.dispose();

    expect(disposed()).toBe(1);
    expect(node.getTextureForReference(target)).not.toBe(copy);
  });

  it('keeps the copy of a target that only reallocates, and retires it at the final disposal', () => {
    separateViewportTextureSizes();
    const node = new ViewportTextureNode();
    const target = new RenderTarget(640, 480);
    const copy = drawnCopy(node, target);
    const disposed = disposalCounter(copy);

    // setSize dispatches the same 'dispose' event, but at the new size the copy has not drawn yet.
    target.setSize(320, 240);
    expect(disposed()).toBe(0);
    expect(node.getTextureForReference(target)).toBe(copy);

    // The next draw resizes the copy; a later disposal at that size is the final retirement.
    node.updateBefore(frameFor(target));
    expect(copy.image).toMatchObject({ width: 320, height: 240 });
    target.dispose();
    expect(disposed()).toBe(1);
    expect(node.getTextureForReference(target)).not.toBe(copy);
  });

  it('keeps a live reference copy while another reference retires', () => {
    separateViewportTextureSizes();
    const node = new ViewportTextureNode();
    const kept = new RenderTarget(640, 480);
    const retiring = new RenderTarget(640, 480);
    const keptCopy = drawnCopy(node, kept);
    drawnCopy(node, retiring);
    const keptDisposed = disposalCounter(keptCopy);

    retiring.dispose();

    expect(keptDisposed()).toBe(0);
    expect(node.getTextureForReference(kept)).toBe(keptCopy);
  });
});
