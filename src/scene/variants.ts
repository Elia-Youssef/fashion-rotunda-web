// KHR_materials_variants, the mannequin's three swatches in one file.
//
// GLTFLoader does not implement this extension. It copies the unknown extension blocks into
// userData and stops there: the root block reaches gltf.userData.gltfExtensions
// (GLTFLoader.js line 2733) and each primitive's block reaches mesh.userData.gltfExtensions
// (line 3964), both through addUnknownExtensionsToUserData (lines 2337-2347). The material swap
// below is the part three.js leaves to the application, ported from the official
// webgl_loader_gltf_variants example: read the variant index, find the primitive's mapping,
// resolve the material through the parser and let the parser finish it.
//
// The npm package ships examples/jsm only, so the example's HTML file is not on disk here; the
// three lines cited above are the loader-side facts this port actually depends on.
//
// Every value that comes out of userData is data from a file, so each one is narrowed before use
// and a malformed block leaves the mesh alone rather than throwing at the visitor.

import { Material, Mesh } from 'three/webgpu';
import type { Object3D } from 'three/webgpu';
import type { GLTF, GLTFParser } from 'three/addons/loaders/GLTFLoader.js';

/** The extension name, as it appears in the glTF file and in userData.gltfExtensions. */
const VARIANTS_EXTENSION = 'KHR_materials_variants';

/** Where a primitive's first material is parked so an unmapped variant can restore it. */
const ORIGINAL_MATERIAL = 'originalMaterial';

export interface VariantTarget {
  root: Object3D;
  parser: GLTFParser;
  variants: string[];
  /**
   * Registers a material the parser just resolved, or the finalized instance a mesh ended up
   * carrying when the parser replaced the assigned one, with the look that asked for it, before
   * it can escape the swap. Registration is what keeps a swap that never finishes (a rejection,
   * or the look being replaced mid-swap) from losing the material and its textures.
   */
  acquire?: (material: Material) => void;
  /**
   * True once the look that asked for this variant no longer counts as its recipient: replaced
   * on screen, or released outright, whichever the caller counts. The swap checks it after
   * every parser resolution and stops before it commits anything further onto the look.
   */
  superseded?: () => boolean;
}

interface VariantMapping {
  material: number;
  variants: number[];
}

/** The extension's own block, as a field map, or null when this object carries none. */
function readExtensionBlock(userData: Record<string, unknown>): Map<string, unknown> | null {
  const extensions = userData['gltfExtensions'];
  if (typeof extensions !== 'object' || extensions === null) {
    return null;
  }
  const block = new Map<string, unknown>(Object.entries(extensions)).get(VARIANTS_EXTENSION);
  if (typeof block !== 'object' || block === null) {
    return null;
  }
  return new Map<string, unknown>(Object.entries(block));
}

/** The variant names in file order. The order is the index space the mappings refer to. */
export function listVariants(gltf: GLTF): string[] {
  const block = readExtensionBlock(gltf.userData);
  if (block === null) {
    return [];
  }
  const list = block.get('variants');
  if (!Array.isArray(list)) {
    return [];
  }
  const items: unknown[] = list;
  const names: string[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const name = new Map<string, unknown>(Object.entries(item)).get('name');
    if (typeof name === 'string' && name.length > 0) {
      names.push(name);
    }
  }
  return names;
}

/** One primitive's mappings: which material to use for which variant indices. */
function readMappings(userData: Record<string, unknown>): VariantMapping[] {
  const block = readExtensionBlock(userData);
  if (block === null) {
    return [];
  }
  const list = block.get('mappings');
  if (!Array.isArray(list)) {
    return [];
  }
  const items: unknown[] = list;
  const mappings: VariantMapping[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const entry = new Map<string, unknown>(Object.entries(item));
    const material = entry.get('material');
    const variants = entry.get('variants');
    if (typeof material !== 'number' || !Array.isArray(variants)) {
      continue;
    }
    const raw: unknown[] = variants;
    const indices: number[] = [];
    for (const index of raw) {
      if (typeof index === 'number') {
        indices.push(index);
      }
    }
    mappings.push({ material, variants: indices });
  }
  return mappings;
}

/**
 * Puts the named variant's materials on every primitive of `root` that maps it, and restores the
 * primitive's first material where the variant has no mapping.
 *
 * Object3D.traverse takes a synchronous callback and the material lookup is a promise, so the
 * meshes are collected first and swapped afterwards. parser.getDependency caches, so a second
 * pass over the same variant costs no download and no new GPU resource.
 *
 * Each resolved material is handed to `acquire` before it reaches a mesh, the finalized
 * instance a mesh ends up carrying is registered the same way, and the swap stops at the first
 * `superseded` report, so a look that is replaced mid-swap keeps every resource owned and has
 * nothing further committed onto it.
 */
export async function selectVariant(target: VariantTarget, name: string): Promise<void> {
  const variantIndex = target.variants.indexOf(name);
  if (variantIndex === -1) {
    throw new Error(`variant "${name}" is not one of: ${target.variants.join(', ')}`);
  }

  const meshes: Mesh[] = [];
  target.root.traverse((object: Object3D) => {
    if (object instanceof Mesh) {
      meshes.push(object);
    }
  });

  for (const mesh of meshes) {
    const mappings = readMappings(mesh.userData);
    if (mappings.length === 0) {
      continue;
    }
    const assigned = mesh.material;
    if (Array.isArray(assigned)) {
      // A glTF primitive carries exactly one material, so an array here means the mesh was built
      // somewhere else and the mapping indices would not mean anything.
      throw new Error(`mesh "${mesh.name}" carries a material array, which no glTF primitive does`);
    }
    if (!(ORIGINAL_MATERIAL in mesh.userData)) {
      mesh.userData[ORIGINAL_MATERIAL] = assigned;
    }

    const mapping = mappings.find((candidate) => candidate.variants.includes(variantIndex));
    if (mapping === undefined) {
      const original: unknown = mesh.userData[ORIGINAL_MATERIAL];
      if (original instanceof Material) {
        mesh.material = original;
      }
      continue;
    }

    const dependency: unknown = await target.parser.getDependency('material', mapping.material);
    if (!(dependency instanceof Material)) {
      throw new Error(`variant "${name}" maps material ${mapping.material}, which did not resolve`);
    }
    target.acquire?.(dependency);
    if (target.superseded?.()) {
      // The look that asked is superseded; the registration above is what keeps the material
      // owned (its owner releases it), and the meshes of a superseded look must stay untouched.
      return;
    }
    mesh.material = dependency;
    // The parser owns the last step: vertex colours, flat shading and the rest are decided per
    // mesh, and skipping it is how a variant ends up rendering with the wrong shader.
    try {
      target.parser.assignFinalMaterial(mesh);
    } finally {
      // Finalization can replace the assigned instance with a clone the parser caches, and can
      // mutate the mesh and then throw. Either way, what the mesh actually carries is a
      // resource of this look now; registering it here is what keeps a swap that fails or stops
      // on a later mesh from losing it.
      const finalized: unknown = mesh.material;
      if (finalized instanceof Material && finalized !== dependency) {
        target.acquire?.(finalized);
      }
    }
  }
}
