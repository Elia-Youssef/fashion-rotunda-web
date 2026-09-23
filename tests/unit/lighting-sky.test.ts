// The procedural sky that replaced the School Field HDR: its colours stay free of green and
// yellow, its nadir is row 0 (three's upload convention, see sky.ts), and ?sky=hdr is the only way
// back to the HDR.

import { DataUtils, EquirectangularReflectionMapping, HalfFloatType, LinearSRGBColorSpace } from 'three';
import { describe, expect, it } from 'vitest';

import {
  ENVIRONMENT_SATURATION,
  SKY_HEIGHT,
  SKY_WIDTH,
  VISIBLE_GROUND_LUMINANCE,
  VISIBLE_ZENITH_LUMINANCE,
  createGradientSkyTexture,
  environmentSkyPalette,
  gradientSkyPixels,
  linearAtLuminance,
  luminance,
  skyRadiance,
  skySourceFromParam,
  skySourceFromSearch,
  visibleSkyPalette,
  withSaturation,
} from '../../src/lighting/sky';
import type { Rgb, SkyPalette } from '../../src/lighting/sky';

function pixel(pixels: Float32Array, width: number, x: number, y: number): Rgb {
  const index = 4 * (y * width + x);
  return [pixels[index], pixels[index + 1], pixels[index + 2]];
}

/** Green or yellow shows as green above the red-blue mean, or as blue below both red and green. */
function greenExcess(rgb: Rgb): number {
  return rgb[1] - (rgb[0] + rgb[2]) / 2;
}

function blueDeficit(rgb: Rgb): number {
  return Math.min(rgb[0], rgb[1]) - rgb[2];
}

describe('colour helpers', () => {
  it('rescales an sRGB hex colour to an exact linear luminance', () => {
    expect(luminance(linearAtLuminance(0x4a7fc4, 2))).toBeCloseTo(2, 10);
    // #808080 is sRGB mid grey: linear equal channels at the asked-for level.
    const grey = linearAtLuminance(0x808080, 0.5);
    expect(grey[0]).toBeCloseTo(0.5, 10);
    expect(grey[1]).toBeCloseTo(0.5, 10);
    expect(grey[2]).toBeCloseTo(0.5, 10);
  });

  it('desaturates toward the grey of the same luminance', () => {
    const blue: Rgb = [0.2, 0.4, 1];
    expect(luminance(withSaturation(blue, 0.3))).toBeCloseTo(luminance(blue), 10);
    expect(withSaturation(blue, 1)).toEqual(blue);
    const grey = withSaturation(blue, 0);
    expect(grey[0]).toBeCloseTo(grey[2], 10);
  });
});

describe('the palettes', () => {
  const palettes: [string, SkyPalette][] = [
    ['visible', visibleSkyPalette()],
    ['environment', environmentSkyPalette()],
  ];

  it.each(palettes)('%s: no band leans green or yellow', (_name, palette) => {
    for (const band of [palette.zenith, palette.horizon, palette.ground]) {
      expect(greenExcess(band)).toBeLessThanOrEqual(1e-9);
      expect(blueDeficit(band)).toBeLessThanOrEqual(1e-9);
    }
  });

  it.each(palettes)('%s: the zenith is blue and the ground is a lit neutral grey', (_name, palette) => {
    expect(palette.zenith[2]).toBeGreaterThan(palette.zenith[0]);
    expect(luminance(palette.ground)).toBeGreaterThan(0);
    expect(palette.ground[0]).toBeCloseTo(palette.ground[1], 10);
    expect(palette.ground[1]).toBeCloseTo(palette.ground[2], 10);
  });

  it('keeps the visible sky in the HDR radiance units the background curve was tuned for', () => {
    const visible = visibleSkyPalette();
    expect(luminance(visible.zenith)).toBeCloseTo(VISIBLE_ZENITH_LUMINANCE, 10);
    expect(luminance(visible.ground)).toBeCloseTo(VISIBLE_GROUND_LUMINANCE, 10);
  });

  it('gives the lighting copy less saturation than the visible copy', () => {
    const chroma = (rgb: Rgb): number => (rgb[2] - rgb[0]) / luminance(rgb);
    const visible = chroma(visibleSkyPalette().zenith);
    const lighting = chroma(environmentSkyPalette().zenith);
    expect(lighting).toBeCloseTo(visible * ENVIRONMENT_SATURATION, 10);
  });
});

describe('skyRadiance', () => {
  const palette = visibleSkyPalette();

  it('returns the named bands at the zenith, the horizon and the nadir', () => {
    const expectRgb = (actual: Rgb, expected: Rgb): void => {
      for (let channel = 0; channel < 3; channel += 1) {
        expect(actual[channel]).toBeCloseTo(expected[channel], 10);
      }
    };
    expectRgb(skyRadiance(palette, 1), palette.zenith);
    expectRgb(skyRadiance(palette, 0), palette.horizon);
    expectRgb(skyRadiance(palette, -1), palette.ground);
  });

  it('clamps an out-of-range sine instead of extrapolating', () => {
    expect(skyRadiance(palette, 2)).toEqual(skyRadiance(palette, 1));
    expect(skyRadiance(palette, -2)).toEqual(skyRadiance(palette, -1));
  });
});

describe('gradientSkyPixels', () => {
  it('puts the ground in row 0 and the zenith in the last row, with no azimuth change', () => {
    const palette = visibleSkyPalette();
    const width = 8;
    const height = 16;
    const pixels = gradientSkyPixels(palette, width, height);
    expect(pixels.length).toBe(width * height * 4);
    const top = pixel(pixels, width, 0, height - 1);
    const bottom = pixel(pixels, width, 0, 0);
    expect(top[2]).toBeGreaterThan(top[0]);
    // Row 0's centre sits a few degrees above the nadir, so a trace of the pale haze remains.
    expect(Math.abs(bottom[0] - bottom[2]) / luminance(bottom)).toBeLessThan(0.01);
    expect(pixel(pixels, width, 5, 3)).toEqual(pixel(pixels, width, 0, 3));
    for (let i = 3; i < pixels.length; i += 4) expect(pixels[i]).toBe(1);
  });

  it('refuses a size that cannot hold a sky and a ground', () => {
    expect(() => gradientSkyPixels(visibleSkyPalette(), 8, 1)).toThrow(RangeError);
    expect(() => gradientSkyPixels(visibleSkyPalette(), 0, 8)).toThrow(RangeError);
  });
});

describe('createGradientSkyTexture', () => {
  it('builds an upright half-float linear equirectangular texture of the shipped size', () => {
    const texture = createGradientSkyTexture(environmentSkyPalette(), 'test sky');
    expect(texture.image.width).toBe(SKY_WIDTH);
    expect(texture.image.height).toBe(SKY_HEIGHT);
    expect(texture.type).toBe(HalfFloatType);
    expect(texture.mapping).toBe(EquirectangularReflectionMapping);
    expect(texture.colorSpace).toBe(LinearSRGBColorSpace);
    expect(texture.flipY).toBe(false);
    const data = texture.image.data as Uint16Array;
    const zenith = environmentSkyPalette().zenith;
    // The last row is close to the zenith (its centre is 0.35 degrees down), within half-float precision.
    const last = 4 * SKY_WIDTH * (SKY_HEIGHT - 1);
    expect(DataUtils.fromHalfFloat(data[last + 2])).toBeCloseTo(zenith[2], 2);
    expect(DataUtils.fromHalfFloat(data[0])).toBeLessThan(DataUtils.fromHalfFloat(data[last]));
    texture.dispose();
  });
});

describe('sky source', () => {
  it('uses the procedural sky unless ?sky=hdr asks for the diagnostic HDR', () => {
    expect(skySourceFromSearch('')).toBe('procedural');
    expect(skySourceFromSearch('?e2e=1&gate=off')).toBe('procedural');
    expect(skySourceFromSearch('?sky=hdr')).toBe('hdr');
    expect(skySourceFromSearch('?webgl=1&sky=hdr')).toBe('hdr');
    expect(skySourceFromSearch('?sky=HDR')).toBe('procedural');
    expect(skySourceFromParam(null)).toBe('procedural');
    expect(skySourceFromParam('room')).toBe('procedural');
    expect(skySourceFromParam('hdr')).toBe('hdr');
  });
});
