// How large a texture is allowed to be, per set. Pure arithmetic over a source size and a cap, so
// the rule can be read and tested without an encoder.
//
// The budget table allows 4096 for the floor marble only and 2048 for everything else on
// desktop. The floor is the one surface the inspection camera stands on, and Unreal splits it
// across four materials on one mesh, so the constant names the MESH and optimize.mjs derives the
// material set from it: a re-export that renames a material still resolves, and a re-export that
// renames the mesh fails loudly instead of silently shipping a 4096 wall.

/** The one mesh whose materials may keep 4096 maps. */
export const FLOOR_MESH_NAME = 'SM_Floor_A';

/**
 * Caps per set, in pixels on the longest side.
 *
 * The half set is the phone set. The texture plan fixes it at 1024 max with 512 for the mannequin maps,
 * and states no floor exception, so the floor is capped at 1024 there too: half of the full set's
 * 2048 today, and still inside the budget's 2048 phone allowance if the floor is ever re-exported
 * at 4096.
 */
export const TEXTURE_CAPS = {
  full: { default: 2048, floor: 4096, mannequin: 2048, staticNormal: 1024, garmentNormal: 1024 },
  half: { default: 1024, floor: 1024, mannequin: 512, staticNormal: 512, garmentNormal: 512 },
};

/**
 * The cap for one texture.
 *
 * @param set 'full' or 'half'.
 * @param flags `{ floor, mannequin, staticNormal, garmentNormal }`. A texture used by both a floor material and a
 *   mannequin material cannot happen in this scene; mannequin wins, because it is the tighter cap.
 *   `staticNormal` marks a normal map on the rotunda or the plinth: tiled marble detail seen mostly at
 *   grazing angles, capped at half the default because six such maps at 2048 UASTC were 6 MB of a
 *   13.6 MB first frame against a 10 MB budget (measured 2026-09-19). `garmentNormal` is a normal map
 *   used only by a look garment (not its mannequin). It is capped at 1024 full / 512 half after the
 *   Zoot output gate measured the full asset at 8.11 MB against its 6 MB ceiling, driven by its Hat
 *   normal's 3.14 MB 2048 UASTC payload.
 */
export function textureCap(set, flags = {}) {
  const caps = TEXTURE_CAPS[set];
  if (!caps) throw new Error(`textureCap: unknown set "${set}"`);
  if (flags.mannequin) return caps.mannequin;
  if (flags.garmentNormal) return caps.garmentNormal;
  if (flags.staticNormal) return caps.staticNormal;
  if (flags.floor) return caps.floor;
  return caps.default;
}

/**
 * The size a texture is resized to: never larger than the source, longest side at most `cap`, aspect
 * preserved, each side a multiple of four.
 *
 * Four matters because ktx pads to the 4x4 block grid anyway; doing it here keeps the manifest's
 * recorded size and the shipped size the same number. The rounding goes down, not up, so "never
 * larger than the source" stays true. The one exception is a source under four pixels, which is
 * raised to the block minimum.
 */
export function targetSize([width, height], cap) {
  const longest = Math.max(width, height);
  if (longest <= cap) return [multipleOfFour(width), multipleOfFour(height)];
  const scale = cap / longest;
  return [multipleOfFour(width * scale), multipleOfFour(height * scale)];
}

/** True when the target differs from the source, which is the only case that spends a sharp pass. */
export function needsResize([width, height], [targetWidth, targetHeight]) {
  return width !== targetWidth || height !== targetHeight;
}

function multipleOfFour(value) {
  const floored = 4 * Math.floor(value / 4);
  return floored < 4 ? 4 : floored;
}
