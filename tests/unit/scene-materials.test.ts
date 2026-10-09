// Unit tests for the material tuning table and applier.

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Mesh, MeshPhysicalMaterial, MeshStandardMaterial } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import {
  DOME_GLASS_MATERIAL,
  DOME_TRANSMISSION_ENABLED,
  applyTunings,
  applyTuning,
  tunedMaterialNames,
  tuningFor,
} from '../../src/scene/materials';
import type { MaterialTuning } from '../../src/scene/materials';

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

function requireTuning(name: string): MaterialTuning {
  const tuning = tuningFor(name);
  if (tuning === null) throw new Error(`expected a tuning for ${name}`);
  return tuning;
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
      expect(requireTuning(name)).toMatchObject({ clearcoat: 1.0, clearcoatRoughness: 0.1 });
    }
  });

  it('exports the global dome transmission decision', () => {
    expect(typeof DOME_TRANSMISSION_ENABLED).toBe('boolean');
  });
});

describe('applyTuning', () => {
  it('upgrades MeshStandardMaterial to MeshPhysicalMaterial when clearcoat is tuned', () => {
    const standard = new MeshStandardMaterial({ roughness: 0.5 });
    standard.name = 'MI_Marble_Nero_Base';
    const mesh = new Mesh(undefined, standard);

    const applied = applyTuning(mesh, requireTuning('MI_Marble_Nero_Base'));
    expect(mesh.material).toBe(applied);
    expect(applied).toBeInstanceOf(MeshPhysicalMaterial);
    const physical = applied as MeshPhysicalMaterial;
    expect(physical.clearcoat).toBe(1.0);
    expect(physical.clearcoatRoughness).toBe(0.1);
  });

  it('preserves existing MeshPhysicalMaterial instance when tuning in place', () => {
    const physical = new MeshPhysicalMaterial({ roughness: 0.2, metalness: 1 });
    physical.name = DOME_GLASS_MATERIAL;
    const mesh = new Mesh(undefined, physical);

    const applied = applyTuning(mesh, requireTuning(DOME_GLASS_MATERIAL));
    expect(applied).toBe(physical);
    expect(mesh.material).toBe(physical);
    expect(physical.transmission).toBe(1.0);
    expect(physical.thickness).toBe(0.02);
    expect(physical.ior).toBe(1.0);
    expect(physical.roughness).toBe(0.05);
    expect(physical.metalness).toBe(0);
    expect(physical.transparent).toBe(false);
    expect(physical.depthWrite).toBe(true);
    expect(physical.opacity).toBe(1.0);
  });

  it('applies anisotropy and rotation on brass', () => {
    const standard = new MeshStandardMaterial({ metalness: 1.0, roughness: 0.3 });
    standard.name = 'MI_Metal_Brass_02';
    const mesh = new Mesh(undefined, standard);

    const applied = applyTuning(mesh, requireTuning('MI_Metal_Brass_02'));
    expect(applied).toBeInstanceOf(MeshPhysicalMaterial);
    const physical = applied as MeshPhysicalMaterial;
    expect(physical.anisotropy).toBe(0.85);
    expect(physical.anisotropyRotation).toBe(0);
  });

  it('applies sheen on woven garment materials', () => {
    const standard = new MeshStandardMaterial();
    standard.name = 'MI_WallisDressA';
    const mesh = new Mesh(undefined, standard);

    const applied = applyTuning(mesh, requireTuning('MI_WallisDressA'));
    expect(applied).toBeInstanceOf(MeshPhysicalMaterial);
    const physical = applied as MeshPhysicalMaterial;
    expect(physical.sheen).toBe(1.0);
    expect(physical.sheenRoughness).toBe(0.6);
    expect(physical.sheenColor.r).toBeCloseTo(0.27, 2);
    expect(physical.sheenColor.g).toBeCloseTo(0.37, 2);
    expect(physical.sheenColor.b).toBeCloseTo(0.63, 2);
  });

  it('rejects a multi-material mesh instead of discarding a material slot', () => {
    const first = new MeshStandardMaterial();
    first.name = 'first';
    const second = new MeshStandardMaterial();
    second.name = 'MI_Marble_Nero_Base';
    const mesh = new Mesh(undefined, [first, second]);

    expect(() => applyTuning(mesh, requireTuning('MI_Marble_Nero_Base'))).toThrow(
      'one material per mesh',
    );
    expect(mesh.material).toEqual([first, second]);
  });

  it('reapplies garment tuning after initial and later variant material assignments', () => {
    const root = new Mesh();
    const first = new MeshStandardMaterial();
    first.name = 'MI_WallisDressA';
    root.material = first;

    applyTunings(root);
    expect(root.material).toBeInstanceOf(MeshPhysicalMaterial);
    if (!(root.material instanceof MeshPhysicalMaterial)) {
      throw new Error('initial variant material did not upgrade');
    }
    expect(root.material.sheen).toBe(1);

    const later = new MeshStandardMaterial();
    later.name = 'MI_WallisDressA';
    root.material = later;

    applyTunings(root);
    expect(root.material).toBeInstanceOf(MeshPhysicalMaterial);
    if (!(root.material instanceof MeshPhysicalMaterial)) {
      throw new Error('later variant material did not upgrade');
    }
    expect(root.material.sheen).toBe(1);
  });
});
