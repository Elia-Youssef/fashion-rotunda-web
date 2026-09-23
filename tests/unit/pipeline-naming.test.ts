import { describe, expect, it } from 'vitest';
import {
  COLOR_SLOTS,
  colorSpaceOfSlots,
  encodingOfSlots,
  isColorSlot,
  isMannequinMaterial,
  isNormalSlot,
  ktx2Format,
  SRGB_SLOT_PATTERN,
} from '../../pipeline/gltf/lib/naming.mjs';

// Colour space is the silent failure of this pipeline: nothing throws when a normal map is written
// as sRGB, the scene is just lit wrong. The encoder decides it from the slot name with its own copy
// of this pattern, so the pair is pinned here rather than trusted.

/** SRGB_PATTERN as @gltf-transform/functions defines it (dist/index.js:2481). */
const LIBRARY_SRGB_PATTERN = /color|emissive|diffuse/i;

/** Every slot name that can appear in the shipped files after material optimization. */
const SHIPPED_SLOTS = [
  'baseColorTexture',
  'emissiveTexture',
  'normalTexture',
  'occlusionTexture',
  'metallicRoughnessTexture',
  'clearcoatTexture',
  'clearcoatRoughnessTexture',
  'clearcoatNormalTexture',
];

describe('colour slots agree with the encoder', () => {
  it('answers sRGB for exactly the slots the library answers sRGB for', () => {
    for (const slot of SHIPPED_SLOTS) {
      expect(isColorSlot(slot)).toBe(LIBRARY_SRGB_PATTERN.test(slot));
    }
  });

  it('keeps the pattern itself in step with the library', () => {
    expect(SRGB_SLOT_PATTERN.source).toBe(LIBRARY_SRGB_PATTERN.source);
    expect(SRGB_SLOT_PATTERN.flags).toBe(LIBRARY_SRGB_PATTERN.flags);
  });

  it('covers the two core colour slots', () => {
    for (const slot of COLOR_SLOTS) expect(isColorSlot(slot)).toBe(true);
  });

  it('calls the data slots data', () => {
    expect(isColorSlot('normalTexture')).toBe(false);
    expect(isColorSlot('occlusionTexture')).toBe(false);
    expect(isColorSlot('metallicRoughnessTexture')).toBe(false);
    expect(isColorSlot('clearcoatNormalTexture')).toBe(false);
  });
});

describe('normal slots', () => {
  it('finds both normal slots and nothing else', () => {
    expect(isNormalSlot('normalTexture')).toBe(true);
    expect(isNormalSlot('clearcoatNormalTexture')).toBe(true);
    expect(isNormalSlot('baseColorTexture')).toBe(false);
    expect(isNormalSlot('occlusionTexture')).toBe(false);
  });

  it('never calls one slot both colour and normal', () => {
    for (const slot of SHIPPED_SLOTS) {
      expect(isColorSlot(slot) && isNormalSlot(slot)).toBe(false);
    }
  });
});

describe('colorSpaceOfSlots and encodingOfSlots', () => {
  it('reads a texture in any colour slot as sRGB', () => {
    expect(colorSpaceOfSlots(['baseColorTexture'])).toBe('srgb');
    expect(colorSpaceOfSlots(['emissiveTexture', 'occlusionTexture'])).toBe('srgb');
  });

  it('reads a data texture, and an orphan with no slots at all, as linear', () => {
    expect(colorSpaceOfSlots(['metallicRoughnessTexture', 'occlusionTexture'])).toBe('linear');
    expect(colorSpaceOfSlots([])).toBe('linear');
  });

  it('sends normal maps to UASTC and everything else to ETC1S', () => {
    expect(encodingOfSlots(['normalTexture'])).toBe('uastc');
    expect(encodingOfSlots(['clearcoatNormalTexture'])).toBe('uastc');
    expect(encodingOfSlots(['baseColorTexture'])).toBe('etc1s');
    expect(encodingOfSlots(['metallicRoughnessTexture', 'occlusionTexture'])).toBe('etc1s');
    expect(encodingOfSlots([])).toBe('etc1s');
  });

  it('names the manifest format', () => {
    expect(ktx2Format('uastc')).toBe('ktx2-uastc');
    expect(ktx2Format('etc1s')).toBe('ktx2-etc1s');
  });
});

describe('isMannequinMaterial', () => {
  it('matches the Unreal mannequin naming for every look', () => {
    expect(isMannequinMaterial('MI_ZootSuit_Mannequin_Base')).toBe(true);
    expect(isMannequinMaterial('MI_WallisDress_Mannequin_Dark')).toBe(true);
    expect(isMannequinMaterial('MI_BlueSilk_Mannequin_Light')).toBe(true);
  });

  it('does not match a garment, a marble or a missing name', () => {
    expect(isMannequinMaterial('MI_ZootSuit')).toBe(false);
    expect(isMannequinMaterial('MI_Marble_Nero_Base')).toBe(false);
    expect(isMannequinMaterial(null)).toBe(false);
  });
});
