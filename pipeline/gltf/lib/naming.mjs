// Pure name rules for texture slots. glTF-Transform names a texture's slots after the material
// property that points at it (listTextureSlots in @gltf-transform/functions/dist/index.js:2585):
// baseColorTexture, normalTexture, occlusionTexture, metallicRoughnessTexture, and extension slots
// such as clearcoatNormalTexture. Two questions are asked of those names and both are pure:
//
//   1. Is the texture colour (sRGB) or data (linear)? Wrong here and the error is silent: a normal
//      map decoded as sRGB lights the whole scene wrong and nothing throws.
//   2. Is it a normal map? Normal maps get UASTC, everything else gets ETC1S.

/**
 * Mirrors SRGB_PATTERN in @gltf-transform/functions (dist/index.js:2481). That pattern is what
 * toktx feeds to `ktx --assign-tf`, so our manifest must answer the same question the same way or
 * the recorded colour space and the shipped file disagree. pipeline-naming.test.ts pins the pair.
 */
export const SRGB_SLOT_PATTERN = /color|emissive|diffuse/i;

/** Normal maps are the one slot family that needs UASTC: ETC1S banding shows as lighting noise. */
const NORMAL_SLOT_PATTERN = /normal/i;

/** The two core colour slots, kept as data so a test can check the pattern covers them. */
export const COLOR_SLOTS = ['baseColorTexture', 'emissiveTexture'];

/** True when a slot name means colour data, which must be encoded and sampled as sRGB. */
export function isColorSlot(slot) {
  return SRGB_SLOT_PATTERN.test(String(slot));
}

/** True when a slot name means a normal map. Independent of isColorSlot; the two never overlap. */
export function isNormalSlot(slot) {
  return NORMAL_SLOT_PATTERN.test(String(slot));
}

/**
 * The colour space a texture is stored in, from the slots it occupies. A texture in any colour slot
 * is sRGB; everything else, including a texture in no slot at all, is linear.
 */
export function colorSpaceOfSlots(slots) {
  return slots.some(isColorSlot) ? 'srgb' : 'linear';
}

/** 'uastc' for normal maps, 'etc1s' for colour and data maps. */
export function encodingOfSlots(slots) {
  return slots.some(isNormalSlot) ? 'uastc' : 'etc1s';
}

/** The manifest format string for a KTX2 texture, matching the schemas file. */
export function ktx2Format(encoding) {
  return `ktx2-${encoding}`;
}

/**
 * True for a mannequin material. The Unreal naming is MI_<Look>_Mannequin_<Variant>, so the word is
 * the whole rule. The mannequin is never the subject of the inspection camera, which is why the half
 * set caps its maps lower than everything else.
 */
export function isMannequinMaterial(materialName) {
  return /mannequin/i.test(String(materialName ?? ''));
}
