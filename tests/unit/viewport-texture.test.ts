// Node environment on purpose: ViewportTextureNode and RenderTarget construct without a GPU, and a stub
// renderer stands in for the three calls updateBefore makes (getRenderTarget, getCanvasTarget and
// copyFramebufferToTexture), so the size bookkeeping is covered without drawing anything.

import { RenderTarget, ViewportTextureNode } from 'three/webgpu';
import type { NodeFrame } from 'three/webgpu';
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
