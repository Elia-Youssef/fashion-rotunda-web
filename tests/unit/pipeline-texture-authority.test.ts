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

  it('accepts array and absent source-name inputs like the Set form', () => {
    const document = new Document();
    const canonical = document.createTexture('T_ZootSuit_Hat_NM').setImage(PLACEHOLDER_BYTES);
    const fromArray = canonicalizeSourceTextures(document, ['T_ZootSuit_Hat_NM'], () => SOURCE_BYTES);
    expect(fromArray.canonicalized).toEqual(['T_ZootSuit_Hat_NM']);
    expect(bytesOf(canonical)).toEqual([...SOURCE_BYTES]);

    // Absent source names mean nothing is canonical: an unnamed texture is mapped, not replaced.
    const unnamed = new Document();
    const stray = unnamed.createTexture().setImage(PLACEHOLDER_BYTES);
    const fromAbsent = canonicalizeSourceTextures(unnamed, undefined, () => SOURCE_BYTES);
    expect(fromAbsent.canonicalized).toEqual([]);
    expect(bytesOf(stray)).toEqual([...PLACEHOLDER_BYTES]);
    expect(fromAbsent.byName.get('')).toBe(stray);
  });

  it('forces the image/png mime type on replaced placeholders and created textures', () => {
    const replaced = new Document();
    const placeholder = replaced
      .createTexture('T_ZootSuit_Hat_NM')
      .setMimeType('image/jpeg')
      .setImage(PLACEHOLDER_BYTES);
    canonicalizeSourceTextures(replaced, new Set(['T_ZootSuit_Hat_NM']), () => SOURCE_BYTES);
    expect(placeholder.getMimeType()).toBe('image/png');
    expect(bytesOf(placeholder)).toEqual([...SOURCE_BYTES]);

    const created = new Document();
    const { byName } = canonicalizeSourceTextures(created, new Set(), () => SOURCE_BYTES);
    const texture = getOrCreateSourceTexture(created, byName, 'T_Mondrian_Dress_ORM', () => SOURCE_BYTES).texture;
    expect(texture.getMimeType()).toBe('image/png');
  });

  it('maps every embedded texture by name, canonical or not', () => {
    const document = new Document();
    const canonical = document.createTexture('T_ZootSuit_Hat_NM').setImage(PLACEHOLDER_BYTES);
    const baked = document.createTexture('MI_ZootSuit_BaseColor').setImage(BAKED_BYTES);
    const { byName } = canonicalizeSourceTextures(document, new Set(['T_ZootSuit_Hat_NM']), () => SOURCE_BYTES);
    expect(byName.get('T_ZootSuit_Hat_NM')).toBe(canonical);
    expect(byName.get('MI_ZootSuit_BaseColor')).toBe(baked);
  });

  it('refuses canonical payloads that are not typed byte arrays', () => {
    const document = new Document();
    document.createTexture('T_ZootSuit_Hat_NM').setImage(PLACEHOLDER_BYTES);
    const notBytes = [137, 80, 78, 71] as unknown as Uint8Array;
    expect(() => canonicalizeSourceTextures(document, new Set(['T_ZootSuit_Hat_NM']), () => notBytes))
      .toThrow('Canonical texture T_ZootSuit_Hat_NM did not provide PNG bytes.');
  });

  it('refuses canonical bytes that are not a non-empty PNG payload', () => {
    const replaced = new Document();
    replaced.createTexture('T_ZootSuit_Hat_NM').setMimeType('image/png').setImage(PLACEHOLDER_BYTES);
    expect(() => canonicalizeSourceTextures(replaced, new Set(['T_ZootSuit_Hat_NM']), () => new Uint8Array()))
      .toThrow('Canonical texture T_ZootSuit_Hat_NM did not provide PNG bytes.');
    expect(bytesOf(replaced.getRoot().listTextures()[0]!)).toEqual([...PLACEHOLDER_BYTES]);

    const created = new Document();
    const { byName } = canonicalizeSourceTextures(created, new Set(), () => SOURCE_BYTES);
    expect(() => getOrCreateSourceTexture(created, byName, 'T_Mondrian_Dress_ORM', () => new Uint8Array(0)))
      .toThrow('Canonical texture T_Mondrian_Dress_ORM did not provide PNG bytes.');
    expect(created.getRoot().listTextures()[0]!.getImage()).toBeNull();
  });
});
