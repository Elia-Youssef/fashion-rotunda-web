// The dissolve shader and the shadow-caster flags applied by the fade callbacks.

import { Mesh } from 'three/webgpu';
import type { Material, Object3D } from 'three/webgpu';
import { hash, screenCoordinate } from 'three/tsl';
import { CROSSFADE_MS } from './crossfade';

/**
 * Turns a fragment's screen coordinate into one integer seed, so the hash below is a function of
 * the pixel and of nothing else. A row stride wider than any drawing buffer this page asks for
 * keeps two pixels of the same frame off the same seed.
 */
const HASH_ROW_STRIDE = 8192;

/**
 * The dissolve's per-pixel threshold: one node, built once, shared by every material of the look
 * that is fading out. hash() is the PCG hash of three/tsl (src/nodes/math/Hash.js lines 11-21),
 * in [0, 1), and screenCoordinate is the fragment's window-relative position in pixels on both
 * backends (src/nodes/display/ScreenNode.js lines 149-171 flips the WebGL 2 frag coord to the
 * WebGPU convention). Screen space, not local position, is what makes the decision shared: the
 * garment and the mannequin under it read the same threshold at the same pixel and are therefore
 * kept or discarded together.
 */
const DISSOLVE_THRESHOLD = hash(screenCoordinate.y.mul(HASH_ROW_STRIDE).add(screenCoordinate.x));

/** User Timing names, read by the proof panel; other modules' wiring depends on them. */
export const SWITCH_START_MARK = 'look-switch-start';
export const SWITCH_MEASURE = 'look-switch';

/**
 * The node three/tsl's uniform() returns, narrowed to what the fade does with it: one number
 * written per frame. The name is not exported from 'three/tsl', and the structural view keeps
 * this module free of renderer internals.
 */
export interface FadeUniform {
  value: number;
}

/** The threshold node's type, taken from the function that builds it rather than re-declared. */
type DissolveThreshold = typeof DISSOLVE_THRESHOLD;

/**
 * GLTFLoader builds classic materials (loadMaterial, GLTFLoader.js lines 3596-3736; the default
 * type is MeshStandardMaterial from createDefaultMaterial, line 2321) and the renderer turns them
 * into node materials per build by copying enumerable properties, including inherited ones,
 * onto the node class for the type (node_modules/three/src/renderers/common/nodes/NodeLibrary.js
 * lines 52-70, reached from NodeBuilder.prebuild, NodeBuilder.js line 3158). The
 * fade writes opacityNode on the classic instance and lets that copy carry it into the shader.
 * Material's type carries neither node slot, so the one assertion below widens to this structural
 * type.
 */
type FadeMaterial = Material & {
  opacityNode: FadeUniform | null;
  alphaTestNode: DissolveThreshold | null;
};

/**
 * One mesh of a look with the castShadow the decorator gave it. The sun's shadow pass draws every
 * caster through one shared override material, so the dissolve cannot reach it and the only
 * honest control is whether the mesh is in the pass at all; this is what "on" restores to.
 */
export interface Caster {
  mesh: Mesh;
  assigned: boolean;
}

/** The material and caster state the dissolve needs, independent of look ownership. */
export interface DissolveTarget {
  materials: Iterable<Material>;
  opacity: FadeUniform;
  casters: Caster[];
}

/**
 * Records every mesh of the look with the caster flag it is holding right now. Called once, after
 * the decorator has run and before the fade can touch anything, so "restore" means the value the
 * lighting decided from the material, not the false every GLB mesh arrives with.
 */
export function captureCasters(loaded: { root: Object3D; casters: Caster[] }): void {
  loaded.casters.length = 0;
  loaded.root.traverse((object: Object3D) => {
    if (object instanceof Mesh) {
      loaded.casters.push({ mesh: object, assigned: object.castShadow });
    }
  });
}

/**
 * Turns the dissolve on or off for every material the look holds. On, the look keeps
 * transparent false and depthWrite true and gets two node slots: opacityNode multiplies the
 * look's uniform into the fragment alpha (NodeMaterial.js lines 865-866) and alphaTestNode
 * discards the fragment when that alpha falls to the threshold (lines 872-887, the discard at
 * 883). Both slots are the same for every surface of the look, and the threshold is a function
 * of the screen pixel alone, so one pixel is one decision for the whole look: it keeps the
 * garment and the mannequin under it together, or drops both and shows the incoming look, which
 * is opaque behind it. A surviving pixel is written with alpha 1 in the opaque pass
 * (lines 899-903, builder.isOpaque at NodeBuilder.js lines 527-531), so the two looks write
 * depth and never sort against each other.
 *
 * Off, both slots go back to null, which is what keeps a material the variant swap parked from
 * carrying the dissolve into a later look that reuses it.
 */
export function setDissolve(look: DissolveTarget, on: boolean): void {
  const opacityNode = on ? look.opacity : null;
  const alphaTestNode = on ? DISSOLVE_THRESHOLD : null;
  for (const material of look.materials) {
    const fadeMaterial = material as FadeMaterial;
    if ((fadeMaterial.opacityNode ?? null) === opacityNode) {
      // Already carrying this look's uniform. A second stamp would move the material's version
      // for nothing, and a moved version with a changed cache key throws the render object away
      // and rebuilds it (RenderObjects.js lines 136-142).
      continue;
    }
    fadeMaterial.opacityNode = opacityNode;
    fadeMaterial.alphaTestNode = alphaTestNode;
    // Both fields change the shader, not a uniform value, so the shader has to be rebuilt once
    // at each end of the fade and never between.
    material.needsUpdate = true;
  }
}

/**
 * Whether the look is in the sun's shadow pass. Off parks every mesh, on gives back what the
 * decorator assigned; the fade holds exactly one of the two looks on at any frame.
 */
export function setCasting(look: Pick<DissolveTarget, 'casters'>, on: boolean): void {
  for (const caster of look.casters) {
    caster.mesh.castShadow = on && caster.assigned;
  }
}

/**
 * Reduced motion gets the old instant swap: a duration of 0 completes the fade on its first
 * frame, which leaves the same pixels on screen as the pre-fade swap did.
 */
export function fadeDurationMs(): number {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : CROSSFADE_MS;
}
