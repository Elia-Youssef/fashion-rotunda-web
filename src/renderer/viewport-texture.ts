// One image size per framebuffer texture for three's ViewportTextureNode, and a retirement
// owner for each copy.
//
// Source references below are to the installed three.js 0.186.1 sources under node_modules/three/src/.
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
import type { EventDispatcher, RenderTargetEventMap, Texture } from 'three/webgpu';

type Reference = Parameters<ViewportTextureNode['getTextureForReference']>[0];
type ReferenceObject = Exclude<Reference, null | undefined>;

/** The 'dispose' event both reference kinds dispatch with an empty payload. */
type DisposeEvents = EventDispatcher<Pick<RenderTargetEventMap, 'dispose'>>;

const separated = new WeakSet<Texture>();
const copySize = new Vector2();
let installed = false;

// The per-reference texture cache getTextureForReference fills, on the node itself or, when the
// node was cloned through sample(), level() or bias(), on the shared reference base it defers to
// (TextureNode.getBase). three keeps the WeakMap private: `_cacheTextures` appears in no public
// type, so the `in` check narrows to the hosts that carry it and the remaining assertion names
// the type the ViewportTextureNode constructor gives it. Retirement deletes a disposed
// reference's copy from this cache; tests/unit/viewport-texture.test.ts pins that on a plain
// node and on a shared reference base.
function cacheOf(node: ViewportTextureNode): WeakMap<object, Texture> | undefined {
  const owner: object = node.referenceNode ?? node;
  if (!('_cacheTextures' in owner)) {
    return undefined;
  }
  return (owner as { _cacheTextures: WeakMap<object, Texture> })._cacheTextures;
}

// Reads the size the reference draws at, the way updateBefore sizes its copy: the canvas target
// by drawing-buffer size (which honours the pixel ratio), a render target by width and height.
// Each member of the reference union already declares its side, so the choice is a narrowing
// check on that union.
function referenceDrawSize(reference: ReferenceObject, out: Vector2): Vector2 {
  if ('getDrawingBufferSize' in reference) {
    return reference.getDrawingBufferSize(out);
  }
  return out.set(reference.width, reference.height);
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
  // Both reference kinds dispatch 'dispose' with an empty payload, but their event maps differ,
  // and a listener call on their union does not typecheck; each kind on its own is assignable to
  // the shared dispatcher shape used here.
  const events: DisposeEvents = reference;
  events.addEventListener('dispose', function referenceDisposed(): void {
    referenceDrawSize(reference, copySize);
    const image = texture.image as { width: number; height: number };
    if (image.width !== copySize.width || image.height !== copySize.height) {
      return;
    }
    events.removeEventListener('dispose', referenceDisposed);
    cache?.delete(reference);
    texture.dispose();
  });
}
