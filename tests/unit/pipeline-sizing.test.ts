import { describe, expect, it } from 'vitest';
import {
  FLOOR_MESH_NAME,
  needsResize,
  targetSize,
  TEXTURE_CAPS,
  textureCap,
} from '../../pipeline/gltf/lib/sizing.mjs';

// The cap table is the budget row "Largest texture" expressed as code. These assertions are
// what stops a re-export at 4096 from shipping a 4096 wall.

describe('TEXTURE_CAPS', () => {
  it('pins the desktop caps: 2048, 4096 for the floor, and 1024 for normals with bounded detail', () => {
    expect(TEXTURE_CAPS.full).toEqual({
      default: 2048, floor: 4096, mannequin: 512, staticData: 1024, staticNormal: 1024, garmentNormal: 1024,
    });
  });

  it('pins the phone caps: 512, and 256 for mannequin and normal maps', () => {
    expect(TEXTURE_CAPS.half).toEqual({
      default: 512, floor: 512, mannequin: 256, staticNormal: 256, garmentNormal: 256,
    });
  });

  it('names the one mesh the wider cap belongs to', () => {
    expect(FLOOR_MESH_NAME).toBe('SM_Floor_A');
  });
});

describe('textureCap', () => {
  it('gives an ordinary texture the default cap', () => {
    expect(textureCap('full', {})).toBe(2048);
    expect(textureCap('half', {})).toBe(512);
    expect(textureCap('full')).toBe(2048);
  });

  it('gives the floor the wider cap on desktop and no exception on a phone', () => {
    expect(textureCap('full', { floor: true })).toBe(4096);
    expect(textureCap('half', { floor: true })).toBe(512);
  });

  it('gives the mannequin the tighter cap, and lets it win over the floor flag', () => {
    expect(textureCap('half', { mannequin: true })).toBe(256);
    expect(textureCap('half', { mannequin: true, floor: true })).toBe(256);
    expect(textureCap('full', { mannequin: true })).toBe(512);
  });

  it('refuses a set it does not know', () => {
    expect(() => textureCap('quarter' as never)).toThrow(/unknown set/);
  });
});

describe('targetSize', () => {
  it('never upscales', () => {
    expect(targetSize([1024, 1024], 2048)).toEqual([1024, 1024]);
    expect(targetSize([512, 256], 4096)).toEqual([512, 256]);
  });

  it('caps the longest side', () => {
    expect(targetSize([4096, 4096], 2048)).toEqual([2048, 2048]);
    expect(targetSize([4096, 4096], 1024)).toEqual([1024, 1024]);
    expect(targetSize([2048, 2048], 512)).toEqual([512, 512]);
  });

  it('preserves the aspect ratio of a non-square texture', () => {
    expect(targetSize([4096, 2048], 2048)).toEqual([2048, 1024]);
    expect(targetSize([1024, 4096], 2048)).toEqual([512, 2048]);
  });

  it('rounds every side down to a multiple of four, which is the block grid ktx pads to anyway', () => {
    expect(targetSize([1000, 1000], 2048)).toEqual([1000, 1000]);
    expect(targetSize([1002, 998], 2048)).toEqual([1000, 996]);
    expect(targetSize([4095, 4095], 2048)).toEqual([2048, 2048]);
  });

  it('raises a source under four pixels to the block minimum, the one case that grows', () => {
    expect(targetSize([3, 3], 2048)).toEqual([4, 4]);
  });
});

describe('needsResize', () => {
  it('is false only when the target is the source', () => {
    expect(needsResize([2048, 2048], [2048, 2048])).toBe(false);
    expect(needsResize([2048, 2048], [1024, 1024])).toBe(true);
    expect(needsResize([2048, 1024], [2048, 512])).toBe(true);
  });
});

describe('staticNormal cap', () => {
  it('halves a normal map on the rotunda or the plinth, and yields to the mannequin cap', () => {
    expect(textureCap('full', { staticNormal: true })).toBe(1024);
    expect(textureCap('full', { staticNormal: true, floor: true })).toBe(1024);
    expect(textureCap('half', { staticNormal: true })).toBe(256);
    expect(textureCap('half', { staticNormal: true, mannequin: true })).toBe(256);
  });
});

describe('garmentNormal cap', () => {
  it('bounds garment-only normal maps without changing mannequin precedence', () => {
    expect(textureCap('full', { garmentNormal: true })).toBe(1024);
    expect(textureCap('half', { garmentNormal: true })).toBe(256);
    expect(textureCap('full', { garmentNormal: true, mannequin: true })).toBe(512);
    expect(textureCap('half', { garmentNormal: true, mannequin: true })).toBe(256);
  });
});
