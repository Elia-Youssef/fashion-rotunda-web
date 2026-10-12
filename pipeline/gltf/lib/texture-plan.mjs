// Texture policy is separate from resizing and encoding: planning never changes the document.
import { Material, PropertyType, Texture } from '@gltf-transform/core';
import { listTextureSlots } from '@gltf-transform/functions';
import { colorSpaceOfSlots, encodingOfSlots, isMannequinMaterial } from './naming.mjs';
import { FLOOR_MESH_NAME, targetSize, textureCapForUsage } from './sizing.mjs';

/** One entry per texture, in root order. File context distinguishes static maps from look maps. */
export function planTextures(document, set, item) {
  const floorTextures = floorTextureSet(document);
  const mannequinTextures = texturesWhere(document, (material) => isMannequinMaterial(material.getName()));
  const seen = new Set();
  return document.getRoot().listTextures().map((texture, index) => {
    const floor = floorTextures.has(texture);
    const mannequin = mannequinTextures.has(texture);
    const slots = listTextureSlots(texture);
    const size = texture.getSize();
    // The old resize loop skipped textures with no readable dimensions before selecting a cap.
    const cap = size ? textureCapForUsage(set, slots, { ...item, floor, mannequin }) : null;
    let name = texture.getName() || `texture-${index}`;
    if (seen.has(name)) {
      let suffix = 2;
      while (seen.has(`${name}-${suffix}`)) suffix += 1;
      name = `${name}-${suffix}`;
    }
    seen.add(name);
    return {
      texture,
      name,
      pattern: exactName(name),
      floor,
      mannequin,
      role: mannequin ? 'mannequin' : floor ? 'floor' : 'other',
      slots,
      size,
      cap,
      target: size ? targetSize(size, cap) : null,
      encoding: encodingOfSlots(slots),
      colorSpace: colorSpaceOfSlots(slots),
    };
  });
}

/** toktx selects by name; anchoring and escaping prevent another texture from matching. */
function exactName(name) {
  return new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/** The textures of the one mesh allowed the wider cap, regardless of material names. */
function floorTextureSet(document) {
  const floorMaterials = new Set();
  for (const mesh of document.getRoot().listMeshes()) {
    if (mesh.getName() !== FLOOR_MESH_NAME) continue;
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial();
      if (material) floorMaterials.add(material);
    }
  }
  return texturesWhere(document, (material) => floorMaterials.has(material));
}

/** Every texture reachable from a material the predicate accepts, extension slots included. */
function texturesWhere(document, predicate) {
  const result = new Set();
  for (const texture of document.getRoot().listTextures()) {
    for (const material of materialsOfTexture(texture)) {
      if (predicate(material)) {
        result.add(texture);
        break;
      }
    }
  }
  return result;
}

/** Walks through extension properties to find all materials sharing a texture. */
function materialsOfTexture(texture) {
  const materials = new Set();
  const seen = new Set();
  const stack = [texture];
  while (stack.length > 0) {
    const node = stack.pop();
    for (const parent of node.listParents()) {
      if (parent instanceof Material) {
        materials.add(parent);
        continue;
      }
      if (parent.propertyType === PropertyType.ROOT || parent instanceof Texture) continue;
      if (seen.has(parent)) continue;
      seen.add(parent);
      stack.push(parent);
    }
  }
  return materials;
}
