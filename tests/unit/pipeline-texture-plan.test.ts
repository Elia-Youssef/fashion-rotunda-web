import { Document } from '@gltf-transform/core';
import type { Material, Texture } from '@gltf-transform/core';
import { KHRMaterialsClearcoat, KHRMaterialsSpecular } from '@gltf-transform/extensions';
import { describe, expect, it, vi } from 'vitest';
import { planTextures } from '../../pipeline/gltf/lib/texture-plan.mjs';

const STATIC_FILE = { file: 'rotunda.glb' };
const LOOK_FILE = { file: 'looks/example.glb', look: {} };

function texture(document: Document, name = 'map', size: [number, number] = [4096, 2048]): Texture {
  // Only dimensions are read: a PNG signature and IHDR dimensions avoid allocating a full raster.
  const header = new Uint8Array(24);
  header.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(header.buffer);
  view.setUint32(16, size[0]);
  view.setUint32(20, size[1]);
  return document.createTexture(name).setMimeType('image/png').setImage(header);
}

function floor(document: Document, material: Material, name = 'SM_Floor_A') {
  document.createMesh(name).addPrimitive(document.createPrimitive().setMaterial(material));
}

describe('texture plan', () => {
  it('derives the floor exception from the exact mesh and follows extension slots in both sets', () => {
    const document = new Document();
    const marble = texture(document);
    const wall = texture(document, 'SM_Floor_A');
    const normal = texture(document, 'detail');
    const material = document.createMaterial('renamed-marble').setBaseColorTexture(marble);
    const clearcoat = document.createExtension(KHRMaterialsClearcoat).createClearcoat().setClearcoatNormalTexture(normal);
    material.setExtension('KHR_materials_clearcoat', clearcoat);
    floor(document, material);
    floor(document, document.createMaterial('floor-name').setBaseColorTexture(wall), 'SM_Floor_A-copy');

    expect(planTextures(document, 'full', STATIC_FILE).map(({ floor, cap, target }) => ({ floor, cap, target })))
      .toEqual([
        { floor: true, cap: 4096, target: [4096, 2048] },
        { floor: false, cap: 2048, target: [2048, 1024] },
        { floor: true, cap: 1024, target: [1024, 512] },
      ]);
    expect(planTextures(document, 'half', STATIC_FILE).map(({ cap }) => cap)).toEqual([512, 512, 256]);
  });

  it('finds mannequin usage through extensions and sharing and keeps the tighter cap over floor', () => {
    const document = new Document();
    const shared = texture(document, 'anonymous');
    const other = document.createMaterial('stone').setBaseColorTexture(shared);
    const mannequin = document.createMaterial('MI_Example_mAnNeQuIn_Light');
    mannequin.setExtension('KHR_materials_clearcoat', document.createExtension(KHRMaterialsClearcoat)
      .createClearcoat().setClearcoatTexture(shared));
    floor(document, other);
    for (const set of ['full', 'half'] as const) {
      expect(planTextures(document, set, LOOK_FILE)[0]).toMatchObject({
        texture: shared, floor: true, mannequin: true, role: 'mannequin',
        cap: set === 'full' ? 512 : 256, target: set === 'full' ? [512, 256] : [256, 128],
      });
    }
  });

  it('applies normal caps by static file or garment context including extension normals', () => {
    const document = new Document();
    const normal = texture(document);
    document.createMaterial('dress').setExtension('KHR_materials_clearcoat',
      document.createExtension(KHRMaterialsClearcoat).createClearcoat().setClearcoatNormalTexture(normal));
    expect(planTextures(document, 'full', STATIC_FILE)[0]).toMatchObject({ cap: 1024, encoding: 'uastc' });
    expect(planTextures(document, 'half', { file: 'plinth.glb' })[0]?.cap).toBe(256);
    expect(planTextures(document, 'full', LOOK_FILE)[0]?.cap).toBe(1024);
    expect(planTextures(document, 'half', LOOK_FILE)[0]?.cap).toBe(256);
    expect(planTextures(document, 'full', { file: LOOK_FILE.file })[0]?.cap).toBe(2048);
  });

  it('caps only exclusively static scalar data and preserves mixed and unused defaults', () => {
    const document = new Document();
    const data = texture(document, 'colour-looking-name');
    const mixed = texture(document, 'data-looking-name');
    texture(document, 'unused');
    const material = document.createMaterial('surface').setMetallicRoughnessTexture(data).setOcclusionTexture(data);
    floor(document, material);
    document.createMaterial('mixed').setBaseColorTexture(mixed).setNormalTexture(mixed);
    expect(planTextures(document, 'full', STATIC_FILE).map(({ cap }) => cap)).toEqual([1024, 2048, 2048]);
    expect(planTextures(document, 'half', STATIC_FILE).map(({ cap }) => cap)).toEqual([512, 512, 512]);
    expect(planTextures(document, 'full', LOOK_FILE).map(({ cap }) => cap)).toEqual([4096, 2048, 2048]);
    expect(planTextures(document, 'full', STATIC_FILE)[1]).toMatchObject({ encoding: 'uastc', colorSpace: 'srgb' });
  });

  const slots: [string, (document: Document, material: Material, image: Texture) => void, string, string][] = [
    ['baseColor', (_d, m, t) => m.setBaseColorTexture(t), 'srgb', 'etc1s'],
    ['emissive', (_d, m, t) => m.setEmissiveTexture(t), 'srgb', 'etc1s'],
    ['normal', (_d, m, t) => m.setNormalTexture(t), 'linear', 'uastc'],
    ['roughness-metallic', (_d, m, t) => m.setMetallicRoughnessTexture(t), 'linear', 'etc1s'],
    ['occlusion', (_d, m, t) => m.setOcclusionTexture(t), 'linear', 'etc1s'],
    ['clearcoat-normal', (d, m, t) => m.setExtension('KHR_materials_clearcoat',
      d.createExtension(KHRMaterialsClearcoat).createClearcoat().setClearcoatNormalTexture(t)), 'linear', 'uastc'],
    ['specular-color', (d, m, t) => m.setExtension('KHR_materials_specular',
      d.createExtension(KHRMaterialsSpecular).createSpecular().setSpecularColorTexture(t)), 'srgb', 'etc1s'],
    ['specular-data', (d, m, t) => m.setExtension('KHR_materials_specular',
      d.createExtension(KHRMaterialsSpecular).createSpecular().setSpecularTexture(t)), 'linear', 'etc1s'],
    ['unused', () => {}, 'linear', 'etc1s'],
  ];
  it.each(slots)('selects colour space and encoding from the %s slot', (_slot, attach, colorSpace, encoding) => {
    const document = new Document();
    const image = texture(document);
    attach(document, document.createMaterial('arbitrary'), image);
    expect(planTextures(document, 'full', STATIC_FILE)[0]).toMatchObject({ colorSpace, encoding });
  });

  it('preserves aspect and block rounding without upscaling apart from the block minimum', () => {
    const document = new Document();
    texture(document, 'large', [8193, 4097]);
    texture(document, 'small', [31, 17]);
    texture(document, 'tiny', [1, 2]);
    expect(planTextures(document, 'full', STATIC_FILE).map(({ target }) => target))
      .toEqual([[2048, 1024], [28, 16], [4, 4]]);
    expect(planTextures(document, 'half', STATIC_FILE)[0]?.target).toEqual([512, 256]);
  });

  it('skips sizing for missing images but still plans naming encoding and colour space', () => {
    const document = new Document();
    const image = document.createTexture();
    document.createMaterial().setBaseColorTexture(image);
    expect(planTextures(document, 'full', STATIC_FILE)[0]).toMatchObject({
      name: 'texture-0', size: null, cap: null, target: null, colorSpace: 'srgb', encoding: 'etc1s',
    });
  });

  it('allocates unique names in root order including generated and suffixed collisions', () => {
    const document = new Document();
    for (const name of ['texture-1', '', 'dup', 'dup-2', 'dup', 'dup']) texture(document, name);
    expect(planTextures(document, 'full', STATIC_FILE).map(({ name }) => name))
      .toEqual(['texture-1', 'texture-1-2', 'dup', 'dup-2', 'dup-3', 'dup-4']);
  });

  it('matches only the exact planned name with every regular expression metacharacter escaped', () => {
    const document = new Document();
    const name = 'a.*+?^${}()|[]\\z';
    texture(document, name);
    texture(document, 'plain');
    const entries = planTextures(document, 'full', STATIC_FILE);
    expect(entries[0]?.pattern.test(name)).toBe(true);
    expect(entries[0]?.pattern.test(`prefix${name}`)).toBe(false);
    expect(entries[0]?.pattern.test(`${name}suffix`)).toBe(false);
    expect(entries[0]?.pattern.test('plain')).toBe(false);
    expect(entries[1]?.pattern.test('plain-2')).toBe(false);
  });

  it('returns deterministic entries without mutating names images or the material graph', () => {
    const document = new Document();
    const first = texture(document, 'duplicate');
    const second = texture(document, 'duplicate');
    const material = document.createMaterial().setBaseColorTexture(first).setNormalTexture(second);
    const originalImage = first.getImage();
    const names = document.getRoot().listTextures().map(t => t.getName());
    const firstPlan = planTextures(document, 'full', STATIC_FILE);
    expect(planTextures(document, 'full', STATIC_FILE)).toEqual(firstPlan);
    expect(document.getRoot().listTextures()).toEqual([first, second]);
    expect(document.getRoot().listTextures().map(t => t.getName())).toEqual(names);
    expect(first.getImage()).toBe(originalImage);
    expect(material.getBaseColorTexture()).toBe(first);
    expect(material.getNormalTexture()).toBe(second);
    expect(firstPlan.map(({ role }) => role)).toEqual(['other', 'other']);
  });

  it('rejects an unknown asset set when a texture needs a sizing decision', () => {
    const document = new Document();
    texture(document);
    expect(() => planTextures(document, 'quarter' as never, STATIC_FILE)).toThrow('unknown set');
  });
});

// Importing the whole optimizer and its dependencies exceeded the default 5 s under load.
const OPTIMIZER_IMPORT_TIMEOUT_MS = 30_000;
it('imports the optimizer without starting its CLI work or altering PATH', async () => {
  const pipelineEnv = vi.fn(() => { throw new Error('CLI work started during import'); });
  vi.doMock('../../pipeline/config.mjs', async (original) => ({
    ...await original<object>(), pipelineEnv,
  }));
  const originalPath = process.env.PATH;
  // A runtime path imports the script without requiring declarations for its private CLI functions.
  const modulePath = '../../pipeline/gltf/optimize.mjs';
  try {
    await import(modulePath);
    expect(pipelineEnv).not.toHaveBeenCalled();
    expect(process.env.PATH).toBe(originalPath);
  } finally {
    vi.doUnmock('../../pipeline/config.mjs');
  }
}, OPTIMIZER_IMPORT_TIMEOUT_MS);
