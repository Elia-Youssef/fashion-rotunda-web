import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const AUTHORED_SPECULAR: Readonly<Record<string, Readonly<Record<string, number>>>> = {
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

function extractSpecularFactors(path: string): Record<string, number> {
  const bytes = readFileSync(path);
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength)) as {
    materials?: Array<{
      name?: string;
      extensions?: { KHR_materials_specular?: { specularFactor?: number } };
    }>;
  };
  return Object.fromEntries(
    (json.materials ?? []).flatMap((material) => {
      const factor = material.extensions?.KHR_materials_specular?.specularFactor;
      return typeof material.name === 'string' && typeof factor === 'number' ? [[material.name, factor]] : [];
    }),
  );
}

describe('serialized KHR_materials_specular output', () => {
  it.each(['full', 'half'] as const)('preserves only authored non-default factors in the %s set', (set) => {
    const root = resolve(process.cwd(), 'public/content', set === 'full' ? '' : 'half');
    for (const [file, expected] of Object.entries(AUTHORED_SPECULAR)) {
      const actual = extractSpecularFactors(resolve(root, file));
      expect(Object.keys(actual).sort(), `${set}/${file}`).toEqual(Object.keys(expected).sort());
      for (const [material, factor] of Object.entries(expected)) {
        expect(actual[material], `${set}/${file} ${material}`).toBeCloseTo(factor, 5);
      }
    }
  });
});
