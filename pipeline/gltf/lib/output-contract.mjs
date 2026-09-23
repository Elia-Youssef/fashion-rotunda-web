// Fail-closed checks for the emitted garment GLBs whose exporter defects required texture repair.
// This operates on a re-read serialized document, not the optimizer's in-memory graph, so prune,
// KTX encoding, and write/read registration mistakes cannot make the manifest falsely green.

/** Exact material-slot contract for both full and half versions of the affected looks. */
export const OUTPUT_CONTRACTS = {
  'looks/zoot-suit.glb': [
    {
      material: 'MI_ZootSuit',
      textures: {
        baseColor: 'MI_ZootSuit_BaseColor',
        normal: 'T_ZootSuit_NM',
        metallicRoughness: 'T_ZootSuit_ORM',
        occlusion: 'T_ZootSuit_ORM',
      },
    },
    {
      material: 'MI_ZootSuit_Hat',
      textures: {
        baseColor: 'T_ZootSuit_Hat_BC',
        normal: 'T_ZootSuit_Hat_NM',
        metallicRoughness: 'T_ZootSuit_Hat_ORM',
        occlusion: 'T_ZootSuit_Hat_ORM',
      },
    },
  ],
  'looks/mondrian-dress.glb': [
    {
      material: 'MI_Mondrian_Dress',
      textures: {
        baseColor: 'T_Mondrian_Dress_BC',
        normal: 'T_Mondrian_Dress_NM',
        metallicRoughness: 'T_Mondrian_Dress_ORM',
        occlusion: 'T_Mondrian_Dress_ORM',
      },
    },
  ],
};

/**
 * Exact non-default KHR_materials_specular factors authored in the Unreal exports. Values absent
 * from this table must not survive on these output files: default extension properties add shader
 * work with no source information, while missing entries below are a serialization failure.
 */
export const SPECULAR_OUTPUT_CONTRACTS = {
  'plinth.glb': {
    MI_Pedestal_Main: 0.6,
  },
  'rotunda.glb': {
    MI_Marble_Nero_Base: 0.4,
    MI_Marble_Nero_Vert: 0.4,
    MI_Metal_Brass_02: 0.25,
  },
  'looks/blue-silk-dress.glb': {
    M_BlueSilk: 0.2,
    MI_BlueSilk_Mannequin_Base: 0.4,
    MI_BlueSilk_Mannequin_Light: 0.4,
    MI_BlueSilk_Mannequin_Dark: 0.4,
  },
  'looks/geoffrey-beene.glb': {
    MI_GeoffryBeene_Mannequin_Base: 0.4,
    MI_GeoffryBeene_Mannequin_Light: 0.4,
    MI_GeoffryBeene_Mannequin_Dark: 0.4,
  },
  'looks/jumpsuit-dress.glb': {
    MI_JumpSuit_Dress: 0.2,
    MI_JumpSuit_Mannequin_Base: 0.4,
    MI_JumpSuit_Mannequin_Light: 0.4,
    MI_JumpSuit_Mannequin_Dark: 0.4,
  },
  'looks/mondrian-dress.glb': {
    MI_Mondrian_Dress: 0.55,
    MI_Mondrian_Mannequin_Base: 0.4,
    MI_Mondrian_Mannequin_Light: 0.4,
    MI_Mondrian_Mannequin_Dark: 0.4,
  },
  'looks/new-look-dress.glb': {
    MI_NewLook_Dress: 0.6,
    MI_NewLook_Mannequin_Base: 0.4,
    MI_NewLook_Mannequin_Light: 0.4,
    MI_NewLook_Mannequin_Dark: 0.4,
  },
  'looks/wallis-dress.glb': {
    MI_WallisDressB: 0.4,
    MI_WallisDress_Mannequin_Base: 0.4,
    MI_WallisDress_Mannequin_Light: 0.4,
    MI_WallisDress_Mannequin_Dark: 0.4,
  },
  'looks/zoot-suit.glb': {
    MI_ZootSuit_Mannequin_Base: 0.4,
    MI_ZootSuit_Mannequin_Light: 0.4,
    MI_ZootSuit_Mannequin_Dark: 0.4,
  },
};

const SLOT_GETTERS = {
  baseColor: (material) => material.getBaseColorTexture(),
  normal: (material) => material.getNormalTexture(),
  metallicRoughness: (material) => material.getMetallicRoughnessTexture(),
  occlusion: (material) => material.getOcclusionTexture(),
};

/**
 * Validates repaired texture slots and authored specular factors in the contracted output files.
 * Other output files deliberately remain unconstrained.
 * Throws one actionable error containing every failed assertion, preventing manifest generation.
 */
export function validateOutputContract(document, { set, file }) {
  const required = OUTPUT_CONTRACTS[file] ?? [];
  const expectedSpecular = SPECULAR_OUTPUT_CONTRACTS[file];
  if (required.length === 0 && !expectedSpecular) return { checked: false, assertions: 0 };

  const failures = [];
  let assertions = 0;
  for (const expected of required) {
    const material = document.getRoot().listMaterials().find((candidate) => candidate.getName() === expected.material);
    if (!material) {
      failures.push(`missing material ${expected.material}`);
      continue;
    }
    assertions += assertNeutralFactors(material, expected.material, failures);
    for (const [slot, expectedName] of Object.entries(expected.textures)) {
      assertions += 1;
      const texture = SLOT_GETTERS[slot](material);
      if (!texture || texture.getName() !== expectedName) {
        failures.push(`${expected.material}.${slot} must reference ${JSON.stringify(expectedName)}`);
        continue;
      }
      assertions += 1;
      const image = texture.getImage();
      if (texture.getMimeType() !== 'image/ktx2' || !image || image.byteLength === 0) {
        failures.push(`${expected.material}.${slot} (${expectedName}) must embed a non-empty image/ktx2 texture`);
      }
    }
  }
  if (expectedSpecular) assertions += assertSpecularFactors(document, expectedSpecular, failures);
  if (failures.length > 0) {
    throw new Error(`Output contract failed for ${set}/${file}: ${failures.join('; ')}`);
  }
  return { checked: true, assertions };
}

function assertSpecularFactors(document, expected, failures) {
  let assertions = 1;
  const actual = new Map(
    document.getRoot().listMaterials().flatMap((material) => {
      const specular = material.getExtension('KHR_materials_specular');
      return specular ? [[material.getName(), specular.getSpecularFactor()]] : [];
    }),
  );
  const expectedNames = Object.keys(expected).sort();
  const actualNames = [...actual.keys()].sort();
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    failures.push(`KHR_materials_specular materials must be exactly ${expectedNames.join(', ')}`);
  }
  for (const [name, factor] of Object.entries(expected)) {
    assertions += 1;
    const actualFactor = actual.get(name);
    if (typeof actualFactor !== 'number' || Math.abs(actualFactor - factor) > 0.000001) {
      failures.push(`${name}.specularFactor must be ${factor}`);
    }
  }
  return assertions;
}

function assertNeutralFactors(material, name, failures) {
  const assertions = 3;
  const base = material.getBaseColorFactor();
  if (base.length !== 4 || base.some((value) => value !== 1)) {
    failures.push(`${name}.baseColorFactor must be [1, 1, 1, 1]`);
  }
  if (material.getMetallicFactor() !== 1) failures.push(`${name}.metallicFactor must be 1`);
  if (material.getRoughnessFactor() !== 1) failures.push(`${name}.roughnessFactor must be 1`);
  return assertions;
}
