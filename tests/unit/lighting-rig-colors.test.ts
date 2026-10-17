import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RIG,
  UNREAL_COLORS,
  daylightParameters,
  hexToLinearRgb,
  kelvinToHex,
  kelvinTintToHex,
  linearRgbToHex,
  normalizeHexColor,
  parseRig,
  serializeRig,
  srgbToLinear,
} from '../../src/lighting/rig';
import { kelvinToRgb } from '../../src/lighting/units';
import { studioLight } from '../support/lighting-rig';

// The color math: hex normalization, the kelvin curve, the sRGB transfer functions, and
// the Unreal-authored kelvin-times-tint combination behind UNREAL_COLORS.

describe('Color Helpers', () => {
  it('normalizes hex strings correctly', () => {
    expect(normalizeHexColor('#FFF')).toBe('#ffffff');
    expect(normalizeHexColor('abc')).toBe('#aabbcc');
    expect(normalizeHexColor('#FF1122')).toBe('#ff1122');
    expect(normalizeHexColor('invalid', '#000000')).toBe('#000000');
  });

  it('converts kelvin to expected authored hex codes', () => {
    expect(kelvinToHex(4500)).toBe('#ffe3bd');
    expect(kelvinToHex(7000)).toBe('#f3f8ff');
    expect(kelvinToHex(6500)).toBe('#ffffff');
  });

  it('round-trips hex and linear RGB', () => {
    const linear = hexToLinearRgb('#ffe3bd');
    expect(linear[0]).toBeCloseTo(1, 2);
    expect(linearRgbToHex(linear)).toBe('#ffe3bd');
  });
});

describe('Authored tint combination (Kelvin x RGB 188,225,255)', () => {
  // The authored sRGB gel every studio rect light carries in the Unreal level.
  const TINT = [188 / 255, 225 / 255, 255 / 255] as const;

  // The Unreal-authored colours stay reproducible from the UNREAL record (Key 4500 K, Fill 7000 K,
  // Back 6500 K) although the web defaults are neutral white 6500 K by client decision on 2026-09-23.
  it('stores kelvinToRgb(K) x srgbToLinear(tint) for each Unreal light, read back through hexToLinearRgb', () => {
    for (const kelvin of [4500, 7000, 6500]) {
      const stored = kelvinTintToHex(kelvin);
      const expectedLinear = [
        kelvinToRgb(kelvin)[0] * srgbToLinear(TINT[0]),
        kelvinToRgb(kelvin)[1] * srgbToLinear(TINT[1]),
        kelvinToRgb(kelvin)[2] * srgbToLinear(TINT[2]),
      ];
      const readBack = hexToLinearRgb(stored);
      expect(readBack[0]).toBeCloseTo(expectedLinear[0], 2);
      expect(readBack[1]).toBeCloseTo(expectedLinear[1], 2);
      expect(readBack[2]).toBeCloseTo(expectedLinear[2], 2);
      for (const channel of readBack) {
        expect(Number.isFinite(channel)).toBe(true);
      }
    }
  });

  it('pins the UNREAL_COLORS record computed from the Unreal table, frozen', () => {
    expect(UNREAL_COLORS).toEqual({
      key: '#bcc8bd',
      fill: '#b3dbff',
      back: '#bce1ff',
      sun: '#f3f8ff',
    });
    expect(Object.isFrozen(UNREAL_COLORS)).toBe(true);
    // The record is not the default: defaults stay neutral white 6500 K.
    for (const id of ['key', 'fill', 'back'] as const) {
      expect(studioLight(DEFAULT_RIG, id).color).not.toBe(UNREAL_COLORS[id]);
    }
    expect(daylightParameters(DEFAULT_RIG.daylight).color).not.toBe(UNREAL_COLORS.sun);
  });

  it('pins all three Unreal-authored combined hex values', () => {
    expect(kelvinTintToHex(4500)).toBe('#bcc8bd');
    expect(kelvinTintToHex(7000)).toBe('#b3dbff');
    expect(kelvinTintToHex(6500)).toBe('#bce1ff');
  });

  it('defaults every studio light to neutral white 6500 K, not the Unreal-authored colours', () => {
    for (const id of ['key', 'fill', 'back'] as const) {
      expect(studioLight(DEFAULT_RIG, id).color).toBe('#ffffff');
      expect(studioLight(DEFAULT_RIG, id).color).toBe(kelvinToHex(6500));
      expect(studioLight(DEFAULT_RIG, id).color).toBe(kelvinTintToHex(6500, [255, 255, 255]));
    }
    expect(daylightParameters(DEFAULT_RIG.daylight).color).toBe('#ffffff');
  });

  it('makes Back exactly the authored gel because 6500 K is the white balance', () => {
    // kelvinToRgb(6500) is exactly (1, 1, 1), so the combined color is the tint itself.
    expect(kelvinTintToHex(6500)).toBe('#bce1ff');
    expect(kelvinTintToHex(6500, [255, 255, 255])).toBe('#ffffff');
  });

  it('differs from kelvin-only colors: the tint is applied, and only once', () => {
    for (const kelvin of [4500, 7000]) {
      const combined = kelvinTintToHex(kelvin);
      expect(combined).not.toBe(kelvinToHex(kelvin));
      // Applying the tint a second time on top of the stored color must be a different
      // color, so a compounded double application would be detectable.
      const twice = linearRgbToHex([
        hexToLinearRgb(combined)[0] * srgbToLinear(TINT[0]),
        hexToLinearRgb(combined)[1] * srgbToLinear(TINT[1]),
        hexToLinearRgb(combined)[2] * srgbToLinear(TINT[2]),
      ]);
      expect(twice).not.toBe(combined);
    }
  });

  it('is deterministic: repeated derivation and serialization round-trips do not drift', () => {
    expect(kelvinTintToHex(4500)).toBe(kelvinTintToHex(4500));
    const roundTripped = parseRig(serializeRig(DEFAULT_RIG), DEFAULT_RIG);
    expect(studioLight(roundTripped, 'key').color).toBe(studioLight(DEFAULT_RIG, 'key').color);
    expect(studioLight(roundTripped, 'fill').color).toBe(studioLight(DEFAULT_RIG, 'fill').color);
    expect(studioLight(roundTripped, 'back').color).toBe(studioLight(DEFAULT_RIG, 'back').color);
  });

  it('rejects non-finite tint channels and clamps each channel to [0, 1]', () => {
    // At the 6500 K white balance, the Kelvin contribution is exactly white, so these pins expose
    // the per-channel tint normalization directly. Non-finite channels collapse to zero.
    expect(kelvinTintToHex(6500, [Number.NaN, 225, 255])).toBe('#00e1ff');
    expect(kelvinTintToHex(6500, [188, Number.POSITIVE_INFINITY, 255])).toBe('#bc00ff');
    expect(kelvinTintToHex(6500, [188, 225, Number.NEGATIVE_INFINITY])).toBe('#bce100');

    // Out-of-range channels clamp: 300 -> 1 and -20 -> 0
    expect(kelvinTintToHex(6500, [300, -20, 255])).toBe('#ff00ff');
    // Non-finite kelvin is normalized by kelvinToRgb's own clamp, output stays valid.
    expect(kelvinTintToHex(Number.NaN)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('sRGB transfer helpers on and off the curve', () => {
  it('srgbToLinear: linear segment below 0.04045, power segment above, ends clamped', () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(0.02)).toBeCloseTo(0.02 / 12.92, 10);
    expect(srgbToLinear(0.04045)).toBeCloseTo(0.04045 / 12.92, 6);
    expect(srgbToLinear(0.5)).toBeCloseTo(Math.pow((0.5 + 0.055) / 1.055, 2.4), 10);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    expect(srgbToLinear(-0.5)).toBe(0);
    expect(srgbToLinear(2)).toBe(1);
  });

  it('linearRgbToHex clamps each channel to [0, 1] before encoding', () => {
    // 0.5 linear encodes as 188 (0xbc); the out-of-range channels pin to 0 and 1
    expect(linearRgbToHex([-1, 0.5, 2])).toBe('#00bcff');
  });

  it('linearRgbToHex uses the 12.92 linear segment below 0.0031308', () => {
    // 0.001 linear is 0.01292 sRGB, which rounds to channel 3 (0x03)
    expect(linearRgbToHex([0.001, 0, 0])).toBe('#030000');
  });
});

describe('normalizeHexColor tolerance', () => {
  it('falls back to white by default and never throws on non-string input', () => {
    expect(normalizeHexColor('not-a-color')).toBe('#ffffff');
    expect(normalizeHexColor(undefined as unknown as string, '#123456')).toBe('#123456');
    expect(normalizeHexColor(42 as unknown as string)).toBe('#ffffff');
  });

  it('an invalid hex color in a v2 link falls back to white', () => {
    const parsed = parseRig('v2;key,1,15,zzzzzz', DEFAULT_RIG);
    expect(studioLight(parsed, 'key').color).toBe('#ffffff');
  });
});
