import { describe, expect, it } from 'vitest';
import {
  isOrmName,
  materialKey,
  NEUTRAL_BASE_COLOR,
  planFactorResets,
  planRepairs,
  sourceTextureName,
} from '../../pipeline/gltf/lib/repairs.mjs';
import type { MaterialSlots } from '../../pipeline/gltf/lib/repairs.mjs';

// The rule under test is the one that repairs the Unreal exporter's mistakes. It is a name rule on
// purpose: a re-export that breaks a different material is repaired without a code change, and a
// re-export that fixes one stops reporting a repair. The cases below are the real export of
// 2026-09-19, so a change here means the export changed.

const ZOOT_TEXTURES = [
  'T_ZootSuit',
  'T_ZootSuit_BC',
  'T_ZootSuit_NM',
  'T_ZootSuit_ORM',
  'T_ZootSuit_Hat_BC',
  'T_ZootSuit_Hat_NM',
  'T_ZootSuit_Hat_ORM',
  'T_ZootSuit_Mannequin_BC',
  'T_ZootSuit_Mannequin_NM',
  'T_ZootSuit_Mannequin_ORM',
];

describe('materialKey', () => {
  it('reads the key out of both Unreal prefixes', () => {
    expect(materialKey('MI_ZootSuit')).toBe('ZootSuit');
    expect(materialKey('M_CLay')).toBe('CLay');
    expect(materialKey('MI_ZootSuit_Hat')).toBe('ZootSuit_Hat');
    expect(materialKey('M_Glass_Flat_SM_Dome_A')).toBe('Glass_Flat_SM_Dome_A');
  });

  it('has no key for a name without the prefix, so such a material is never repaired', () => {
    expect(materialKey('Material73835')).toBeNull();
    expect(materialKey('')).toBeNull();
    expect(materialKey(null)).toBeNull();
    expect(materialKey('MI_')).toBeNull();
  });
});

describe('sourceTextureName and isOrmName', () => {
  it('builds the Unreal texture name', () => {
    expect(sourceTextureName('ZootSuit', 'BC')).toBe('T_ZootSuit_BC');
    expect(sourceTextureName('ZootSuit_Hat', 'ORM')).toBe('T_ZootSuit_Hat_ORM');
  });

  it('recognises an ORM pack by suffix only, ignoring case', () => {
    expect(isOrmName('T_ZootSuit_ORM')).toBe(true);
    expect(isOrmName('t_zootsuit_orm')).toBe(true);
    expect(isOrmName('T_ZootSuit_NM')).toBe(false);
    expect(isOrmName('T_ORM_Something')).toBe(false);
    expect(isOrmName(null)).toBe(false);
  });
});

describe('planRepairs on the export of 2026-09-19', () => {
  it('moves an ORM out of the normal slot and fills the two slots it belongs in', () => {
    const repairs = planRepairs(
      {
        name: 'MI_ZootSuit',
        baseColor: 'MI_ZootSuit_BaseColor',
        normal: 'T_ZootSuit_ORM',
        metallicRoughness: null,
        occlusion: null,
      },
      ZOOT_TEXTURES,
    );
    expect(repairs).toEqual([
      { slot: 'normal', from: 'T_ZootSuit_ORM', to: 'T_ZootSuit_NM', reason: 'orm-in-normal-slot' },
      { slot: 'metallicRoughness', from: null, to: 'T_ZootSuit_ORM', reason: 'empty-slot' },
      { slot: 'occlusion', from: null, to: 'T_ZootSuit_ORM', reason: 'empty-slot' },
    ]);
  });

  it('fills a missing base colour and leaves a correct normal slot alone', () => {
    const repairs = planRepairs(
      {
        name: 'MI_ZootSuit_Hat',
        baseColor: null,
        normal: 'T_ZootSuit_Hat_NM',
        metallicRoughness: null,
        occlusion: 'T_ZootSuit_Hat_ORM',
      },
      ZOOT_TEXTURES,
    );
    expect(repairs).toEqual([
      { slot: 'baseColor', from: null, to: 'T_ZootSuit_Hat_BC', reason: 'empty-slot' },
      { slot: 'metallicRoughness', from: null, to: 'T_ZootSuit_Hat_ORM', reason: 'empty-slot' },
    ]);
  });

  it('repairs nothing when every slot is already right', () => {
    const repairs = planRepairs(
      {
        name: 'MI_ZootSuit_Mannequin_Base',
        baseColor: 'a',
        normal: 'b',
        metallicRoughness: 'c',
        occlusion: 'd',
      },
      ZOOT_TEXTURES,
    );
    expect(repairs).toEqual([]);
  });

  it('repairs nothing when the source texture the rule wants is absent', () => {
    // MI_WallisDressA has an empty metallic-roughness slot, and the folder holds no
    // T_WallisDressA_ORM. A rule that guessed here would point a slot at another look's map.
    const repairs = planRepairs(
      { name: 'MI_WallisDressA', baseColor: 'x', normal: 'T_Wallis_Dress_NM', metallicRoughness: null },
      ['T_WallisDress', 'T_Wallis_Dress_BC', 'T_Wallis_Dress_NM'],
    );
    expect(repairs).toEqual([]);
  });

  it('repairs nothing for a material whose name carries no key', () => {
    expect(planRepairs({ name: 'Material73835', baseColor: null }, ['T_Material73835_BC'])).toEqual([]);
  });

  it('leaves an ORM in the normal slot when no normal map exists to replace it with', () => {
    // Documented limit: the rule only fills, it never clears. Nothing in the export hits this.
    const repairs = planRepairs(
      { name: 'MI_X', baseColor: 'a', normal: 'T_X_ORM', metallicRoughness: 'b', occlusion: 'c' },
      ['T_X_ORM'],
    );
    expect(repairs).toEqual([]);
  });

  it('treats a slot the caller omitted as empty', () => {
    // readSlots always passes all four, but the rule must not depend on that.
    const repairs = planRepairs({ name: 'MI_X', baseColor: 'a', normal: 'b' }, ['T_X_ORM']);
    expect(repairs.map((repair) => repair.slot)).toEqual(['metallicRoughness', 'occlusion']);
  });

  it('accepts a Set as well as an array', () => {
    const repairs = planRepairs({ name: 'MI_X', baseColor: null }, new Set(['T_X_BC']));
    expect(repairs).toHaveLength(1);
    expect(repairs[0]!.to).toBe('T_X_BC');
  });

  it('plans nothing for a call without a material instead of throwing', () => {
    // The plan is a pure function over possibly broken exporter data: no material, no plan.
    expect(planRepairs(null as unknown as MaterialSlots, ZOOT_TEXTURES)).toEqual([]);
  });

  it('plans nothing when the list of available textures is missing', () => {
    // A missing texture folder must not look like one that holds every texture.
    expect(planRepairs({ name: 'MI_Phantom', baseColor: null }, null)).toEqual([]);
  });

  it('sees exactly the names a Set holds', () => {
    expect(planRepairs({ name: 'MI_Phantom', baseColor: null }, new Set(['T_Other_BC']))).toEqual([]);
  });
});

describe('planFactorResets', () => {
  const repairBase = [
    { slot: 'baseColor' as const, from: null, to: 'T_X_BC', reason: 'empty-slot' as const },
  ];
  const repairMr = [
    { slot: 'metallicRoughness' as const, from: null, to: 'T_X_ORM', reason: 'empty-slot' as const },
  ];

  it('puts a zeroed base colour factor back to white, which is what makes the repair visible', () => {
    // The exporter writes baseColorFactor [0,0,0,0] where it wrote no base colour. Installing the
    // texture without this reset ships a black garment and every test still passes.
    expect(planFactorResets(repairBase, { baseColor: [0, 0, 0, 0], metallic: 1, roughness: 1 })).toEqual([
      { factor: 'baseColor', from: [0, 0, 0, 0], to: [1, 1, 1, 1] },
    ]);
  });

  it('puts metallic and roughness back to one when an ORM is installed', () => {
    expect(planFactorResets(repairMr, { baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0 })).toEqual([
      { factor: 'metallic', from: 0, to: 1 },
      { factor: 'roughness', from: 0, to: 1 },
    ]);
  });

  it('touches only the factors belonging to a slot that was repaired', () => {
    const white = { baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.6 };
    const black = { baseColor: [0, 0, 0, 0], metallic: 1, roughness: 1 };
    expect(planFactorResets(repairBase, white)).toEqual([]);
    expect(planFactorResets(repairMr, black)).toEqual([]);
  });

  it('resets nothing when no repair was made', () => {
    expect(planFactorResets([], { baseColor: [0, 0, 0, 0], metallic: 0, roughness: 0 })).toEqual([]);
  });

  it('treats a missing base colour factor as the glTF default', () => {
    expect(planFactorResets(repairBase, { baseColor: null, metallic: 1, roughness: 1 })).toEqual([]);
    expect(NEUTRAL_BASE_COLOR).toEqual([1, 1, 1, 1]);
  });

  it('resets a factor that leaves the glTF default in a single channel', () => {
    // One off channel is enough to tint or darken the repaired map, so any difference from the
    // default forces the reset; only a fully neutral factor is left alone.
    expect(planFactorResets(repairBase, { baseColor: [1, 0, 0, 0], metallic: 1, roughness: 1 })).toEqual([
      { factor: 'baseColor', from: [1, 0, 0, 0], to: [1, 1, 1, 1] },
    ]);
  });
});
