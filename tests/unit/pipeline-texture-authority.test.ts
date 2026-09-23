import { Document } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';
import { canonicalizeSourceTextures, getOrCreateSourceTexture } from '../../pipeline/gltf/lib/texture-authority.mjs';

const SOURCE_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const PLACEHOLDER_BYTES = new Uint8Array([0, 0, 0, 0]);
const BAKED_BYTES = new Uint8Array([8, 7, 6, 5]);

function bytesOf(texture: ReturnType<Document['createTexture']>): number[] {
  return [...(texture.getImage() ?? new Uint8Array())];
}

describe('texture authority', () => {
  // The audit found this pattern across ten maps in eight looks, not just the three materials that
  // happen to require slot repairs. Keep the rule generic: exact Unreal texture name is the only
  // authority key, while differently named baked maps are deliberately out of scope.
  it('replaces a same-named embedded placeholder even when that slot needs no repair', () => {
    const document = new Document();
    const canonical = document
      .createTexture('T_ZootSuit_Hat_NM')
      .setMimeType('image/png')
      .setImage(PLACEHOLDER_BYTES);
    const baked = document
      .createTexture('MI_ZootSuit_BaseColor')
      .setMimeType('image/png')
      .setImage(BAKED_BYTES);

    const { canonicalized } = canonicalizeSourceTextures(
      document,
      new Set(['T_ZootSuit_Hat_NM']),
      (name) => {
        expect(name).toBe('T_ZootSuit_Hat_NM');
        return SOURCE_BYTES;
      },
    );

    expect(canonicalized).toEqual(['T_ZootSuit_Hat_NM']);
    expect(bytesOf(canonical)).toEqual([...SOURCE_BYTES]);
    // A different exporter-baked name is not a canonical Unreal source name and must survive.
    expect(bytesOf(baked)).toEqual([...BAKED_BYTES]);
  });

  it('creates a missing repair target from canonical PNG bytes', () => {
    const document = new Document();
    const { byName } = canonicalizeSourceTextures(document, new Set(), () => SOURCE_BYTES);

    const first = getOrCreateSourceTexture(document, byName, 'T_Mondrian_Dress_ORM', () => SOURCE_BYTES);
    const second = getOrCreateSourceTexture(document, byName, 'T_Mondrian_Dress_ORM', () => SOURCE_BYTES);

    expect(first.created).toBe(true);
    expect(bytesOf(first.texture)).toEqual([...SOURCE_BYTES]);
    expect(second.created).toBe(false);
    expect(second.texture).toBe(first.texture);
  });
});
