// One image size per framebuffer texture for three's ViewportTextureNode.
//
// Source references below are to the installed three.js 0.186.0 sources under node_modules/three/src/.
//
// The dome glass refracts the room through a ViewportTextureNode (nodes/functions/
// PhysicalLightingModel.js lines 70-71). The node keeps one framebuffer texture per render target, made
// with Texture.clone() (nodes/display/ViewportTextureNode.js line 135), and a clone shares the
// original's Source (textures/Texture.js line 478), so every per-target texture reads and writes one
// image size. updateBefore (ViewportTextureNode.js lines 159-198) flags a texture for reallocation only
// when that shared size differs from its own target's size.
//
// The post chain draws the scene twice per frame at the same size: the pre-pass, then the scene pass.
// After a pixel-ratio step of the resolution scaler, the pre-pass resizes the shared image and its
// texture is reallocated; the scene pass then finds the size already equal and keeps its GPU texture
// at the previous size, so WebGPU rejects the copy into it as out of bounds, every frame until the
// next step.
//
// A Source of its own gives each per-target texture its own size, so each one is reallocated when its
// own target changes. The default framebuffer texture, used with no render target, is left as it is.

import { Source, ViewportTextureNode } from 'three/webgpu';
import type { Texture } from 'three/webgpu';

type Reference = Parameters<ViewportTextureNode['getTextureForReference']>[0];

const separated = new WeakSet<Texture>();
let installed = false;

/**
 * Patches ViewportTextureNode so each render target's framebuffer texture tracks its own size. Call it
 * before the first frame; later calls do nothing.
 */
export function separateViewportTextureSizes(): void {
  if (installed) {
    return;
  }
  installed = true;
  const prototype = ViewportTextureNode.prototype;
  const shared = prototype.getTextureForReference;
  prototype.getTextureForReference = function (
    this: ViewportTextureNode,
    reference: Reference = null,
  ): Texture {
    const texture = shared.call(this, reference);
    if (reference !== null && !separated.has(texture)) {
      separated.add(texture);
      const { width, height } = texture.image as { width: number; height: number };
      texture.source = new Source({ width, height });
    }
    return texture;
  };
}
