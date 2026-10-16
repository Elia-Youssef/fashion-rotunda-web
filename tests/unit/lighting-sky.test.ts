// The procedural sky that replaced the School Field HDR: its colours stay free of green and
// yellow, its nadir is row 0 (three's upload convention, see sky.ts), and ?sky=hdr is the only way
// back to the HDR.

import { Buffer } from 'node:buffer';
import {
  DataUtils,
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
} from 'three';
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
import { daylightParameters } from '../../src/lighting/rig';

function pixel(pixels: Float32Array, width: number, x: number, y: number): Rgb {
  const index = 4 * (y * width + x);
  return [pixels[index], pixels[index + 1], pixels[index + 2]];
}

function sameBytes(actual: Float32Array | Uint16Array, expected: Float32Array | Uint16Array): boolean {
  return Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength)
    .equals(Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength));
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
  // Freeze the pre-choice gradient independently of the production palette and sampler.
  function previousPixels(visible: boolean): Float32Array {
    const levels = visible ? [2, 2.6, 0.55] : [1, 0.03, 0.09];
    const colors = [0x4a7fc4, 0xc6d8ec, 0x808080].map((hex, i) =>
      withSaturation(linearAtLuminance(hex, levels[i]), visible ? 1 : 0.09));
    const result = new Float32Array(SKY_WIDTH * SKY_HEIGHT * 4);
    for (let y = 0; y < SKY_HEIGHT; y += 1) {
      const sine = Math.sin(((y + 0.5) / SKY_HEIGHT - 0.5) * Math.PI);
      const target = sine >= 0 ? colors[0] : colors[2];
      const blend = Math.abs(sine) ** (sine >= 0 ? (visible ? 0.55 : 1) : 0.3);
      for (let x = 0; x < SKY_WIDTH; x += 1) {
        const index = 4 * (y * SKY_WIDTH + x);
        for (let c = 0; c < 3; c += 1) {
          result[index + c] = colors[1][c] + (target[c] - colors[1][c]) * blend;
        }
        result[index + 3] = 1;
      }
    }
    return result;
  }

  it('keeps every visible pixel and half-float texel identical to the previous sky', () => {
    const previous = previousPixels(true);
    expect(sameBytes(gradientSkyPixels(visibleSkyPalette()), previous)).toBe(true);
    const texture = createGradientSkyTexture(visibleSkyPalette(), 'visible');
    expect(sameBytes(texture.image.data as Uint16Array, Uint16Array.from(previous, DataUtils.toHalfFloat))).toBe(true);
    texture.dispose();
  });

  it('adds only the specified cosine squared lobe to every previous lighting texel', () => {
    const previous = previousPixels(false);
    const expected = new Float32Array(previous.length);
    const [bx, by, bz] = daylightParameters(0.5).direction;
    const zenith = withSaturation(linearAtLuminance(0x4a7fc4, 1), 0.09);
    // Reconstruct the old gradient in double precision before the final Float32 rounding.
    const horizon = withSaturation(linearAtLuminance(0xc6d8ec, 0.03), 0.09);
    const ground: Rgb = [0.09, 0.09, 0.09];
    let unchangedHemisphere = true;
    for (let y = 0; y < SKY_HEIGHT; y += 1) {
      const elevation = ((y + 0.5) / SKY_HEIGHT - 0.5) * Math.PI;
      const sine = Math.sin(elevation);
      const target = sine >= 0 ? zenith : ground;
      const blend = Math.abs(sine) ** (sine >= 0 ? 1 : 0.3);
      for (let x = 0; x < SKY_WIDTH; x += 1) {
        const azimuth = ((x + 0.5) / SKY_WIDTH - 0.5) * 2 * Math.PI;
        const cosine = Math.cos(elevation) * (Math.cos(azimuth) * bx + Math.sin(azimuth) * bz) + sine * by;
        const weight = 0.35 * Math.max(0, cosine) ** 2;
        const index = 4 * (y * SKY_WIDTH + x);
        for (let c = 0; c < 3; c += 1) {
          expected[index + c] = horizon[c] + (target[c] - horizon[c]) * blend + zenith[c] * weight;
        }
        expected[index + 3] = 1;
        if (cosine <= 0) {
          for (let c = 0; c < 4; c += 1) {
            unchangedHemisphere &&= expected[index + c] === previous[index + c];
          }
        }
      }
    }
    expect(unchangedHemisphere).toBe(true);
    expect(sameBytes(gradientSkyPixels(environmentSkyPalette()), expected)).toBe(true);
    const texture = createGradientSkyTexture(environmentSkyPalette(), 'lighting');
    expect(sameBytes(texture.image.data as Uint16Array, Uint16Array.from(expected, DataUtils.toHalfFloat))).toBe(true);
    texture.dispose();
  });

  it('peaks opposite the sun at 0.35 of zenith and adds nothing on the sun-facing hemisphere', () => {
    const palette = environmentSkyPalette();
    const pixels = gradientSkyPixels(palette);
    const [sx, sy, sz] = daylightParameters(0.5).direction.map((v) => -v);
    let peak = -Infinity;
    let peakCosineToSun = 1;
    let sunFacingMaxError = 0;
    for (let y = 0; y < SKY_HEIGHT; y += 1) {
      const elevation = ((y + 0.5) / SKY_HEIGHT - 0.5) * Math.PI;
      const base = skyRadiance(palette, Math.sin(elevation));
      for (let x = 0; x < SKY_WIDTH; x += 1) {
        const azimuth = ((x + 0.5) / SKY_WIDTH - 0.5) * 2 * Math.PI;
        const cosineToSun = Math.cos(elevation) * (Math.cos(azimuth) * sx + Math.sin(azimuth) * sz) +
          Math.sin(elevation) * sy;
        const added = luminance(pixel(pixels, SKY_WIDTH, x, y)) - luminance(base);
        if (cosineToSun >= 0) sunFacingMaxError = Math.max(sunFacingMaxError, Math.abs(added));
        if (added > peak) {
          peak = added;
          peakCosineToSun = cosineToSun;
        }
      }
    }
    expect(peak).toBeCloseTo(0.35 * luminance(palette.zenith), 4);
    expect(peakCosineToSun).toBeLessThan(-0.9999);
    expect(sunFacingMaxError).toBeLessThan(1e-7);
  });

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

  it('refuses a fractional width or height', () => {
    // Row and column indexing assumes whole texels; a fractional side has no defined layout.
    expect(() => gradientSkyPixels(visibleSkyPalette(), 8.5, 16)).toThrow(RangeError);
    expect(() => gradientSkyPixels(visibleSkyPalette(), 512, 127.5)).toThrow(RangeError);
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

  it('carries the given name and the filtering the dome read path needs', () => {
    // Linear mag and min filtering is what makes the gradient smooth on WebGL 2 without the
    // float-linear extension (see the doc comment on createGradientSkyTexture); one level, no
    // generated mipmaps, and an upload flag: three's needsUpdate is write-only, so the visible
    // contract is the texture version it bumps.
    const texture = createGradientSkyTexture(visibleSkyPalette(), 'visible sky');
    expect(texture.name).toBe('visible sky');
    expect(texture.magFilter).toBe(LinearFilter);
    expect(texture.minFilter).toBe(LinearFilter);
    expect(texture.generateMipmaps).toBe(false);
    expect(texture.version).toBeGreaterThan(0);
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
