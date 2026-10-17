import { describe, expect, it } from 'vitest';
import '../support/lighting-environment';
import {
  DataTexture,
  DataUtils,
  EquirectangularReflectionMapping,
  FloatType,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import { createSkyOnlyBackground } from '../../src/lighting/visible-sky';

// The derivation of the visitor-facing sky copy from an HDR source: which sources are accepted,
// the size caps, and the row remap the copy carries.

describe('visible HDR background derivation', () => {
  it('rejects sources that are not half or full floating-point HDR data textures', () => {
    const misTyped = new DataTexture(new Float32Array(2 * 4 * 4), 2, 4, undefined, FloatType);
    misTyped.type = UnsignedByteType;
    expect(() => createSkyOnlyBackground(misTyped)).toThrow(TypeError);
    expect(() => createSkyOnlyBackground(misTyped))
      .toThrowError('HDR background source must use half or full floating-point pixels');

    const singleColumn = new DataTexture(new Float32Array(1 * 4 * 4), 1, 4, undefined, FloatType);
    expect(() => createSkyOnlyBackground(singleColumn))
      .toThrowError('HDR background source must be a floating-point data texture');

    const bytePixels = new DataTexture(new Uint8Array(2 * 4 * 4), 2, 4, undefined, UnsignedByteType);
    expect(() => createSkyOnlyBackground(bytePixels))
      .toThrowError('HDR background source must be a floating-point data texture');
  });

  it('caps the derived background at 512 by half that in pixels, and at two rows', () => {
    const wide = new DataTexture(new Float32Array(600 * 600 * 4), 600, 600, undefined, FloatType);
    wide.name = 'school field';
    wide.mapping = EquirectangularReflectionMapping;
    wide.colorSpace = SRGBColorSpace;
    wide.wrapS = RepeatWrapping;
    wide.wrapT = RepeatWrapping;
    wide.magFilter = LinearFilter;
    wide.minFilter = LinearMipmapLinearFilter;
    wide.anisotropy = 8;
    wide.generateMipmaps = false;
    wide.flipY = true;
    const background = createSkyOnlyBackground(wide) as DataTexture;
    expect(background.image.width).toBe(512);
    expect(background.image.height).toBe(256);
    expect(background.name).toBe('school field visible sky');
    expect(background.type).toBe(FloatType);
    expect(background.mapping).toBe(EquirectangularReflectionMapping);
    expect(background.colorSpace).toBe(SRGBColorSpace);
    expect(background.wrapS).toBe(RepeatWrapping);
    expect(background.wrapT).toBe(RepeatWrapping);
    expect(background.magFilter).toBe(LinearFilter);
    expect(background.minFilter).toBe(LinearMipmapLinearFilter);
    expect(background.anisotropy).toBe(8);
    expect(background.generateMipmaps).toBe(false);
    expect(background.flipY).toBe(true);
    // three's needsUpdate is a write-only setter that bumps version, so the readable proof
    // that createSkyOnlyBackground flagged the copy for upload is a positive version.
    expect(background.version).toBeGreaterThan(0);

    const tiny = new DataTexture(new Float32Array(2 * 4 * 4), 2, 4, undefined, FloatType);
    const small = createSkyOnlyBackground(tiny) as DataTexture;
    expect(small.image.width).toBe(2);
    expect(small.image.height).toBe(2);
    expect(small.name).toBe('HDR visible sky');
  });

  it('round-trips half-float sky pixels through the derived background', () => {
    const encode = DataUtils.toHalfFloat;
    const decode = DataUtils.fromHalfFloat;
    const width = 2;
    const height = 2;
    const top = [1.5, 0.5, 2, 1];
    const bottom = [0.25, 3, 0.125, 1];
    const pixels = new Uint16Array(width * height * 4);
    for (let x = 0; x < width; x += 1) {
      for (let channel = 0; channel < 4; channel += 1) {
        pixels[4 * (0 * width + x) + channel] = encode(top[channel]);
        pixels[4 * (1 * width + x) + channel] = encode(bottom[channel]);
      }
    }
    const source = new DataTexture(pixels, width, height, undefined, HalfFloatType);
    source.flipY = true;
    const background = createSkyOnlyBackground(source) as DataTexture;
    expect(background.type).toBe(HalfFloatType);
    const visible = background.image.data as Uint16Array;
    for (let channel = 0; channel < 4; channel += 1) {
      // Row 0 keeps the preserved zenith row exactly; row 1 samples the source between rows 0
      // and 1 at the remapped position (preserve 0.2 to limit 0.245 of the source height).
      expect(decode(visible[4 * (0 * width) + channel])).toBe(top[channel]);
      expect(decode(visible[4 * (1 * width) + channel]))
        .toBeCloseTo(top[channel] + (bottom[channel] - top[channel]) * 0.245, 2);
    }
  });
});
