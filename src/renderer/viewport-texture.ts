// One image size per framebuffer texture for three's ViewportTextureNode, and a retirement
// owner for each copy.
//
// Source references below are to the installed three.js 0.186.0 sources under node_modules/three/src/.
//
// The dome glass refracts the room through a ViewportTextureNode (nodes/functions/
// PhysicalLightingModel.js lines 70-71). The node keeps one framebuffer texture per render target, made
// with Texture.clone() (nodes/display/ViewportTextureNode.js line 135), and a clone shares the
// original's TextureSource (textures/Texture.js line 478), so every per-target texture reads and writes
// one image size. updateBefore (ViewportTextureNode.js lines 159-198) flags a texture for reallocation
// only when that shared size differs from its own target's size.
//
// The post chain draws the scene twice per frame at the same size: the pre-pass, then the scene pass.
// After a pixel-ratio step of the resolution scaler, the pre-pass resizes the shared image and its
// texture is reallocated; the scene pass then finds the size already equal and keeps its GPU texture
// at the previous size, so WebGPU rejects the copy into it as out of bounds, every frame until the
// next step.
//
// A TextureSource of its own (the r186 name; the old `Source` alias logs a deprecation warning) gives
// each per-target texture its own size, so each one is reallocated when its own target changes. The
// default framebuffer texture, used with no render target, is left as it is.
//
// The node never releases those per-target copies: they sit in a WeakMap keyed by the reference
// (ViewportTextureNode.js lines 133-141) and no disposal path touches them, so every render target a
// post-graph rebuild retires leaves its copy uploaded forever and the renderer's texture count grows
// with each resize. The override below retires a copy beside its creation, on the reference's own
// 'dispose' event, which the render targets of a retired graph dispatch when the graph disposes them.
//
// RenderTarget.setSize dispatches the same event, but only after assigning the new size
// (core/RenderTarget.js lines 365-391), while updateBefore keeps each copy's image at the size of its
// last draw (ViewportTextureNode.js lines 171-191). A copy whose image still matches its reference
// was therefore retired at the size it last drew, while a mismatch means the reference reallocated
// itself and will draw again with this copy: the copy stays cached, keeps its own size record and the
// listener stays armed for the reference's eventual retirement. The one case the mismatch cannot
// distinguish is a reference that is resized and then retired without a draw between the two, which
// this codebase never does (the rebuild path retires targets as last drawn; the scaler path, which
// resizes in place, retains the graph).

import { TextureSource, Vector2, ViewportTextureNode } from 'three/webgpu';
import type { Texture } from 'three/webgpu';

type Reference = Parameters<ViewportTextureNode['getTextureForReference']>[0];
type ReferenceObject = Exclude<Reference, null | undefined>;

/** The cache the shared getTextureForReference fills, on the node or on its shared reference base. */
type CacheHost = {
  referenceNode?: CacheHost | null;
  _cacheTextures?: WeakMap<object, Texture>;
};

/** A reference read the way updateBefore sizes its copy: a render target by width and height, the
 *  canvas target by drawing-buffer size (ViewportTextureNode.js lines 165-179). */
type SizedReference = {
  getDrawingBufferSize?: (target: Vector2) => Vector2;
  width?: number;
  height?: number;
};

const separated = new WeakSet<Texture>();
const copySize = new Vector2();
let installed = false;

function cacheOf(node: ViewportTextureNode): WeakMap<object, Texture> | undefined {
  const host = node as unknown as CacheHost;
  return (host.referenceNode ?? host)._cacheTextures;
}

/**
 * Patches ViewportTextureNode so each render target's framebuffer texture tracks its own size and
 * is disposed with its target. Call it before the first frame; later calls do nothing.
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
    if (reference !== null && reference !== undefined && !separated.has(texture)) {
      separated.add(texture);
      const { width, height } = texture.image as { width: number; height: number };
      texture.source = new TextureSource({ width, height });
      retireWith(cacheOf(this), reference, texture);
    }
    return texture;
  };
}

/** One retirement owner per copy: the dispose event of the reference it was cloned for. */
function retireWith(
  cache: WeakMap<object, Texture> | undefined,
  reference: ReferenceObject,
  texture: Texture,
): void {
  // Both reference kinds extend EventDispatcher, but their typed maps differ, so the dispose
  // subscription is made through one structural shape.
  const events = reference as unknown as {
    addEventListener(type: 'dispose', listener: () => void): void;
    removeEventListener(type: 'dispose', listener: () => void): void;
  };
  events.addEventListener('dispose', function referenceDisposed(): void {
    const sized = reference as unknown as SizedReference;
    if (typeof sized.getDrawingBufferSize === 'function') {
      sized.getDrawingBufferSize(copySize);
    } else {
      copySize.set(sized.width ?? 0, sized.height ?? 0);
    }
    const image = texture.image as { width: number; height: number };
    if (image.width !== copySize.width || image.height !== copySize.height) {
      return;
    }
    events.removeEventListener('dispose', referenceDisposed);
    cache?.delete(reference);
    texture.dispose();
  });
}
