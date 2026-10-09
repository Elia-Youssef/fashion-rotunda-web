import { Document } from '@gltf-transform/core';
import { KHRMaterialsClearcoat } from '@gltf-transform/extensions';
import { listTextureSlots } from '@gltf-transform/functions';
import { describe, expect, it } from 'vitest';
import { targetSize, textureCapForUsage } from '../../pipeline/gltf/lib/sizing.mjs';

const staticFiles = ['rotunda.glb', 'plinth.glb'];

describe('texture caps by complete slot usage', () => {
  it.each(['metallicRoughnessTexture', 'occlusionTexture'])(
    'caps a static %s at 1024, including floor data', (slot) => {
      for (const file of staticFiles) {
        for (const floor of [false, true]) {
          const cap = textureCapForUsage('full', [slot], { file, floor });
          expect(cap).toBe(1024);
          expect(targetSize([2048, 2048], cap)).toEqual([1024, 1024]);
        }
      }
    },
  );

  it('caps a packed metallic-roughness and occlusion texture at 1024', () => {
    expect(textureCapForUsage('full', ['metallicRoughnessTexture', 'occlusionTexture'], {
      file: 'rotunda.glb',
    })).toBe(1024);
  });

  it.each(['baseColorTexture', 'normalTexture', 'emissiveTexture', 'clearcoatNormalTexture'])(
    'excludes scalar data shared with a %s on another material', (slot) => {
      const document = new Document();
      const texture = document.createTexture('arbitrary-name');
      document.createMaterial('scalar surface').setMetallicRoughnessTexture(texture);
      const other = document.createMaterial('other surface');
      if (slot === 'baseColorTexture') other.setBaseColorTexture(texture);
      else if (slot === 'normalTexture') other.setNormalTexture(texture);
      else if (slot === 'emissiveTexture') other.setEmissiveTexture(texture);
      else {
        const clearcoat = document.createExtension(KHRMaterialsClearcoat).createClearcoat();
        other.setExtension('KHR_materials_clearcoat', clearcoat.setClearcoatNormalTexture(texture));
      }
      const slots = listTextureSlots(texture);
      expect(slots).toContain(slot);
      expect(textureCapForUsage('full', slots, { file: 'rotunda.glb' })).toBe(2048);
      expect(textureCapForUsage('full', slots, { file: 'rotunda.glb', floor: true })).toBe(4096);
    },
  );

  it('excludes empty and unknown slot sets from the static data cap', () => {
    for (const slots of [[], ['specularTexture'], ['metallicRoughnessTexture', 'specularTexture']]) {
      expect(textureCapForUsage('full', slots, { file: 'plinth.glb' })).toBe(2048);
    }
  });

  it('keeps garment scalar data at the default cap', () => {
    for (const slot of ['metallicRoughnessTexture', 'occlusionTexture']) {
      expect(textureCapForUsage('full', [slot], { file: 'looks/any-look.glb', look: {} })).toBe(2048);
    }
  });

  it('caps every mannequin slot at 512 with precedence over other classes', () => {
    for (const slot of ['baseColorTexture', 'normalTexture', 'metallicRoughnessTexture',
      'occlusionTexture', 'emissiveTexture']) {
      const cap = textureCapForUsage('full', [slot], {
        file: 'looks/any-look.glb', look: {}, mannequin: true, floor: true,
      });
      expect(cap).toBe(512);
      expect(targetSize([1024, 1024], cap)).toEqual([512, 512]);
    }
  });

  it('keeps floor colour at 4096 and architectural and garment normals at 1024', () => {
    expect(textureCapForUsage('full', ['baseColorTexture'], {
      file: 'rotunda.glb', floor: true,
    })).toBe(4096);
    expect(textureCapForUsage('full', ['normalTexture'], { file: 'plinth.glb' })).toBe(1024);
    expect(textureCapForUsage('full', ['normalTexture'], {
      file: 'looks/any-look.glb', look: {},
    })).toBe(1024);
  });

  it('preserves the half set across slot and file classes', () => {
    const slotSets = [[], ['baseColorTexture'], ['metallicRoughnessTexture'], ['occlusionTexture'],
      ['metallicRoughnessTexture', 'occlusionTexture'], ['metallicRoughnessTexture', 'baseColorTexture'],
      ['normalTexture'], ['clearcoatNormalTexture']];
    for (const file of [...staticFiles, 'looks/any-look.glb']) {
      for (const slots of slotSets) {
        for (const floor of [false, true]) {
          for (const mannequin of [false, true]) {
            const normalOnly = slots.length > 0 && slots.every((slot) => /normal/i.test(slot));
            const expected = mannequin || normalOnly ? 512 : 1024;
            expect(textureCapForUsage('half', slots, {
              file, look: file.startsWith('looks/') ? {} : undefined, floor, mannequin,
            })).toBe(expected);
          }
        }
      }
    }
  });
});
