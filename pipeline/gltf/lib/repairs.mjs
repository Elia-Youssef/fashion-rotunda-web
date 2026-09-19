// The material repair rule, as a pure function over names.
//
// The Unreal glTF exporter dropped or mis-assigned texture slots on a few materials: the zoot
// suit's MI_ZootSuit carries T_ZootSuit_ORM in the normal slot and has no metallic-roughness, and
// MI_ZootSuit_Hat has no base colour. Rather than list the broken materials, the repair is a name
// rule, so a re-export that breaks a different material is repaired too and a re-export that fixes
// one stops reporting a repair.
//
// The rule: for a material named MI_<Key> or M_<Key>, the source textures T_<Key>_BC, T_<Key>_NM
// and T_<Key>_ORM fill the base colour, normal, and metallic-roughness plus occlusion slots when
// the slot is empty, or when the normal slot holds a texture whose name ends in _ORM.
//
// Unreal's ORM packs occlusion in R, roughness in G and metallic in B, which is exactly the glTF
// layout, so one texture legitimately fills both the metallic-roughness and the occlusion slot.
//
// This module decides only WHAT to change. optimize.mjs resolves each name to a texture and applies
// it, so nothing here touches a file or a glTF document.

/** The four slots the rule can fill, in the order repairs are reported. */
export const REPAIRABLE_SLOTS = ['baseColor', 'normal', 'metallicRoughness', 'occlusion'];

/** Which source suffix feeds which slot. */
export const SLOT_SUFFIX = {
  baseColor: 'BC',
  normal: 'NM',
  metallicRoughness: 'ORM',
  occlusion: 'ORM',
};

/**
 * The key inside an Unreal material name: MI_ZootSuit -> ZootSuit, M_Glass_Flat -> Glass_Flat.
 * A name with no MI_ or M_ prefix (Material73835) has no key and is never repaired.
 */
export function materialKey(materialName) {
  const match = /^(?:MI|M)_(.+)$/.exec(String(materialName ?? ''));
  return match ? match[1] : null;
}

/** The source texture name a key and a suffix resolve to, without the .png extension. */
export function sourceTextureName(key, suffix) {
  return `T_${key}_${suffix}`;
}

/** True for a texture named as an Unreal ORM pack. Case is ignored; the exporter is not consistent. */
export function isOrmName(textureName) {
  return /_orm$/i.test(String(textureName ?? ''));
}

/**
 * Plans the repairs for one material.
 *
 * @param material `{ name, baseColor, normal, metallicRoughness, occlusion }`, each slot holding the
 *   current texture name or null.
 * @param available the source texture names present for this asset, without extensions.
 * @returns one entry per slot to change: `{ slot, from, to, reason }`. Empty when nothing is wrong,
 *   when the material name carries no key, or when the source texture the rule wants is missing.
 */
export function planRepairs(material, available) {
  const key = materialKey(material?.name);
  if (key === null) return [];
  const names = available instanceof Set ? available : new Set(available ?? []);
  const repairs = [];
  for (const slot of REPAIRABLE_SLOTS) {
    const current = material[slot] ?? null;
    const reason = repairReason(slot, current);
    if (reason === null) continue;
    const to = sourceTextureName(key, SLOT_SUFFIX[slot]);
    if (!names.has(to)) continue;
    repairs.push({ slot, from: current, to, reason });
  }
  return repairs;
}

/** The glTF defaults for the factors that multiply a repaired texture. */
export const NEUTRAL_BASE_COLOR = [1, 1, 1, 1];

/**
 * Plans the factor resets a set of repairs forces.
 *
 * A slot the exporter left empty also carries a factor, and that factor multiplies whatever texture
 * is put in the slot. Every material repaired here was written with baseColorFactor [0, 0, 0, 0],
 * which renders the garment black however good the base colour map is, and with metallic and
 * roughness at 0, which renders it as a mirror however good the ORM is. Installing the texture means
 * putting its factor back to the glTF default.
 *
 * Only the factors belonging to a slot that was actually repaired are touched, so a material with a
 * deliberate tint and a texture already in the slot is never rewritten.
 *
 * @param repairs the output of planRepairs.
 * @param factors `{ baseColor: number[], metallic: number, roughness: number }`.
 */
export function planFactorResets(repairs, factors) {
  const slots = new Set(repairs.map((repair) => repair.slot));
  const resets = [];
  if (slots.has('baseColor')) {
    const current = factors.baseColor ?? NEUTRAL_BASE_COLOR;
    if (NEUTRAL_BASE_COLOR.some((value, index) => current[index] !== value)) {
      resets.push({ factor: 'baseColor', from: [...current], to: [...NEUTRAL_BASE_COLOR] });
    }
  }
  if (slots.has('metallicRoughness')) {
    if (factors.metallic !== 1) resets.push({ factor: 'metallic', from: factors.metallic, to: 1 });
    if (factors.roughness !== 1) resets.push({ factor: 'roughness', from: factors.roughness, to: 1 });
  }
  return resets;
}

/** Why a slot needs filling, or null when it is already correct. */
function repairReason(slot, current) {
  if (current === null) return 'empty-slot';
  // An ORM pack in the normal slot is the exporter mistake worth naming: the slot looks filled, so
  // nothing downstream complains, and the model ships lit by a roughness map.
  if (slot === 'normal' && isOrmName(current)) return 'orm-in-normal-slot';
  return null;
}
