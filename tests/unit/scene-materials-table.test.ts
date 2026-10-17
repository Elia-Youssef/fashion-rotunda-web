// Unit tests for the material tuning table.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DOME_GLASS_MATERIAL, tunedMaterialNames, tuningFor } from '../../src/scene/materials';
import type { MaterialTuning } from '../../src/scene/materials';
import { requireTuning } from '../support/scene-materials';

/**
 * Extracts material names from a glb file by reading its JSON chunk header.
 * Shipped files have JSON chunk as first chunk after the 12-byte header.
 */
function extractMaterialNames(glbPath: string): string[] {
  const bytes = readFileSync(glbPath);
  if (bytes.length < 20) return [];
  const jsonLength = bytes.readUInt32LE(12);
  const jsonText = bytes.toString('utf8', 20, 20 + jsonLength);
  const parsed: unknown = JSON.parse(jsonText);
  if (typeof parsed !== 'object' || parsed === null || !('materials' in parsed)) return [];
  const materials = parsed.materials;
  if (!Array.isArray(materials)) return [];
  return materials.flatMap((material) => {
    if (typeof material !== 'object' || material === null || !('name' in material)) return [];
    return typeof material.name === 'string' && material.name.length > 0 ? [material.name] : [];
  });
}

/** Names whose emitted full-quality material retains the authored clearcoat extension. */
function extractClearcoatMaterialNames(glbPath: string): string[] {
  const bytes = readFileSync(glbPath);
  if (bytes.length < 20) return [];
  const jsonLength = bytes.readUInt32LE(12);
  const jsonText = bytes.toString('utf8', 20, 20 + jsonLength);
  const parsed: unknown = JSON.parse(jsonText);
  if (typeof parsed !== 'object' || parsed === null || !('materials' in parsed)) return [];
  const materials = parsed.materials;
  if (!Array.isArray(materials)) return [];
  return materials.flatMap((material) => {
    if (
      typeof material !== 'object' ||
      material === null ||
      !('name' in material) ||
      typeof material.name !== 'string' ||
      !('extensions' in material) ||
      typeof material.extensions !== 'object' ||
      material.extensions === null ||
      !('KHR_materials_clearcoat' in material.extensions)
    ) {
      return [];
    }
    return [material.name];
  });
}

function collectShippedMaterialNames(): Map<string, Set<string>> {
  const sets = new Map<string, Set<string>>();
  const contentDir = resolve(process.cwd(), 'public/content');
  for (const setName of ['full', 'half'] as const) {
    const setRoot = setName === 'full' ? contentDir : resolve(contentDir, 'half');
    const files: string[] = [resolve(setRoot, 'rotunda.glb'), resolve(setRoot, 'plinth.glb')];
    const looksDir = resolve(setRoot, 'looks');
    for (const entry of readdirSync(looksDir)) {
      if (entry.endsWith('.glb')) {
        files.push(resolve(looksDir, entry));
      }
    }

    const names = new Set<string>();
    for (const file of files) {
      for (const name of extractMaterialNames(file)) {
        names.add(name);
      }
    }
    sets.set(setName, names);
  }
  return sets;
}

describe('materials tuning table', () => {
  it('every tuned name exists in the full and half shipped glTF sets', () => {
    const shippedMaterials = collectShippedMaterialNames();
    const tunedNames = tunedMaterialNames();

    expect(tunedNames.length).toBeGreaterThan(0);
    for (const [setName, names] of shippedMaterials) {
      for (const name of tunedNames) {
        expect(names.has(name), `tuned material "${name}" must exist in ${setName} glTF files`).toBe(
          true,
        );
      }
    }
  });

  it('the dome entry is the only one with transmission', () => {
    const tunedNames = tunedMaterialNames();
    for (const name of tunedNames) {
      const tuning = tuningFor(name);
      expect(tuning).not.toBeNull();
      if (name === DOME_GLASS_MATERIAL) {
        expect(tuning?.transmission).toBe(1.0);
      } else {
        expect(tuning?.transmission).toBeUndefined();
      }
    }
  });

  it('no entry sets a property that the extension it names does not own', () => {
    // The exported dome glass also needs metallic=0 to reveal the sky through transmission.
    // KHR_materials_clearcoat: clearcoat, clearcoatRoughness
    // KHR_materials_anisotropy: anisotropy, anisotropyRotation
    // KHR_materials_sheen: sheen, sheenRoughness, sheenColor
    const allowedKeysPerMaterial: Record<string, (keyof MaterialTuning)[]> = {
      [DOME_GLASS_MATERIAL]: ['transmission', 'thickness', 'ior', 'metalness', 'roughness'],
      MI_Marble_Nero_Base: ['clearcoat', 'clearcoatRoughness'],
      MI_Marble_Nero_Vert: ['clearcoat', 'clearcoatRoughness'],
      MI_Quartzite_BlueFusion: ['clearcoat', 'clearcoatRoughness'],
      MI_Marble_SilverWave: ['clearcoat', 'clearcoatRoughness'],
      MI_Metal_Brass_02: ['anisotropy', 'anisotropyRotation'],
      MI_WallisDressA: ['sheen', 'sheenRoughness', 'sheenColor'],
      MI_WallisDressB: ['sheen', 'sheenRoughness', 'sheenColor'],
      MI_NewLook_Dress: ['sheen', 'sheenRoughness', 'sheenColor'],
      M_BlueSilk: ['baseSaturation', 'baseBrightness', 'baseContrast'],
    };

    for (const name of tunedMaterialNames()) {
      const tuning = requireTuning(name);
      const allowed = allowedKeysPerMaterial[name];
      expect(allowed, `allowed keys defined for ${name}`).toBeDefined();
      for (const key of Object.keys(tuning)) {
        expect(
          allowed,
          `material ${name} sets ${String(key)} which is not in its allowed extension properties`,
        ).toContain(key);
      }
    }
  });

  it('returns null for materials not in the tuning table', () => {
    expect(tuningFor('MI_Quartzite_White_Base')).toBeNull();
    expect(tuningFor('MI_Quartzite_White_Vert')).toBeNull();
    expect(tuningFor('MI_Pedestal_Main')).toBeNull();
    expect(tuningFor('M_CLay')).toBeNull();
    expect(tuningFor('MI_WallisDress_Mannequin_Base')).toBeNull();
    expect(tuningFor('Unknown_Material')).toBeNull();
  });

  it('restores both authored Nero clearcoat materials after the half tier strips clearcoat', () => {
    const contentDir = resolve(process.cwd(), 'public/content');
    const fullClearcoat = extractClearcoatMaterialNames(resolve(contentDir, 'rotunda.glb')).sort();
    const halfClearcoat = extractClearcoatMaterialNames(resolve(contentDir, 'half/rotunda.glb'));
    const authoredNero = ['MI_Marble_Nero_Base', 'MI_Marble_Nero_Vert'];

    expect(fullClearcoat).toEqual(authoredNero);
    expect(halfClearcoat).toEqual([]);
    for (const name of authoredNero) {
      expect(requireTuning(name)).toMatchObject({
        clearcoat: name === 'MI_Marble_Nero_Vert' ? 0.3 : 0.5,
        clearcoatRoughness: 0.1,
      });
    }
  });
});
