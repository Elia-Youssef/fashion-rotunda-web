import { Document, Material, Texture } from '@gltf-transform/core';
import { KHRMaterialsSpecular, Specular } from '@gltf-transform/extensions';
import { describe, expect, it } from 'vitest';
import {
  OUTPUT_CONTRACTS,
  SPECULAR_OUTPUT_CONTRACTS,
  validateOutputContract,
} from '../../pipeline/gltf/lib/output-contract.mjs';

const SLOT_SETTERS = {
  baseColor: (material: Material, texture: Texture) => material.setBaseColorTexture(texture),
  normal: (material: Material, texture: Texture) => material.setNormalTexture(texture),
  metallicRoughness: (material: Material, texture: Texture) => material.setMetallicRoughnessTexture(texture),
  occlusion: (material: Material, texture: Texture) => material.setOcclusionTexture(texture),
};

function contractedDocument(file: string): Document {
  const document = new Document();
  const textures = new Map<string, Texture>();
  const materials = new Map<string, Material>();
  for (const required of OUTPUT_CONTRACTS[file] ?? []) {
    const material = materials.get(required.material) ?? document.createMaterial(required.material);
    materials.set(required.material, material);
    for (const [slot, name] of Object.entries(required.textures)) {
      let texture = textures.get(name);
      if (!texture) {
        texture = document.createTexture(name).setMimeType('image/ktx2').setImage(new Uint8Array([1]));
        textures.set(name, texture);
      }
      SLOT_SETTERS[slot as keyof typeof SLOT_SETTERS](material, texture);
    }
  }
  const expectedSpecular = SPECULAR_OUTPUT_CONTRACTS[file];
  if (expectedSpecular) {
    const extension = document.createExtension(KHRMaterialsSpecular);
    for (const [name, factor] of Object.entries(expectedSpecular)) {
      const material = materials.get(name) ?? document.createMaterial(name);
      materials.set(name, material);
      material.setExtension('KHR_materials_specular', extension.createSpecular().setSpecularFactor(factor));
    }
  }
  return document;
}

describe('emitted output contracts', () => {
  it.each(['full', 'half'] as const)('accepts every serialized material requirement in the %s set', (set) => {
    const files = new Set([...Object.keys(OUTPUT_CONTRACTS), ...Object.keys(SPECULAR_OUTPUT_CONTRACTS)]);
    for (const file of files) {
      expect(validateOutputContract(contractedDocument(file), { set, file })).toMatchObject({ checked: true });
    }
  });

  it('fails closed when a repaired slot is absent', () => {
    const document = contractedDocument('looks/zoot-suit.glb');
    document.getRoot().listMaterials().find((material) => material.getName() === 'MI_ZootSuit')!.setNormalTexture(null);

    expect(() => validateOutputContract(document, { set: 'full', file: 'looks/zoot-suit.glb' }))
      .toThrow('MI_ZootSuit.normal must reference "T_ZootSuit_NM"');
  });

  it('fails closed when a referenced texture is not an embedded KTX2 image', () => {
    const document = contractedDocument('looks/mondrian-dress.glb');
    document.getRoot().listTextures().find((texture) => texture.getName() === 'T_Mondrian_Dress_ORM')!
      .setMimeType('image/png');

    expect(() => validateOutputContract(document, { set: 'half', file: 'looks/mondrian-dress.glb' }))
      .toThrow('T_Mondrian_Dress_ORM) must embed a non-empty image/ktx2 texture');
  });

  it('fails closed when exporter factors would mute a repaired texture', () => {
    const document = contractedDocument('looks/mondrian-dress.glb');
    document.getRoot().listMaterials()[0]!.setRoughnessFactor(0);

    expect(() => validateOutputContract(document, { set: 'full', file: 'looks/mondrian-dress.glb' }))
      .toThrow('MI_Mondrian_Dress.roughnessFactor must be 1');
  });

  it('fails closed when a serialized authored specular factor is lost', () => {
    const document = contractedDocument('rotunda.glb');
    document.getRoot().listMaterials().find((material) => material.getName() === 'MI_Metal_Brass_02')!
      .getExtension<Specular>('KHR_materials_specular')!
      .setSpecularFactor(1);

    expect(() => validateOutputContract(document, { set: 'full', file: 'rotunda.glb' }))
      .toThrow('MI_Metal_Brass_02.specularFactor must be 0.25');
  });

  it('fails closed when a serialized authored specular property is missing', () => {
    const document = contractedDocument('plinth.glb');
    document.getRoot().listMaterials()[0]!.setExtension('KHR_materials_specular', null);

    expect(() => validateOutputContract(document, { set: 'half', file: 'plinth.glb' }))
      .toThrow('MI_Pedestal_Main.specularFactor must be 0.6');
  });

  it('does not impose garment requirements on unrelated output files', () => {
    expect(validateOutputContract(new Document(), { set: 'full', file: 'looks/uncontracted.glb' }))
      .toEqual({ checked: false, assertions: 0 });
  });
});
