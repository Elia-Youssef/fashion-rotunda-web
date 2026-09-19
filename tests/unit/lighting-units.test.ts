import { describe, expect, it } from 'vitest';
import {
  CANDELA_RANGE,
  KELVIN_RANGE,
  candelaToNits,
  kelvinToRgb,
  unrealToThreeDirection,
  unrealToThreePosition,
} from '../../src/lighting/units';

// A second implementation of the colour temperature, written from published data rather than from the
// module's code. The module approximates the Planckian locus with Krystek's polynomials; this reads the
// chromaticity straight out of the CIE tables and does the same two normalising steps afterwards. The two
// agree only if the approximation is right, which is the point.
const PUBLISHED_PLANCKIAN_XY: Record<number, [number, number]> = {
  2700: [0.4599, 0.4106],
  4500: [0.3608, 0.3635],
  6500: [0.3135, 0.3237],
  8000: [0.2952, 0.3048],
};

/** CIE xyY at Y = 1 to linear BT.709, the sRGB primaries with no transfer function applied. */
function referenceLinearRgb(x: number, y: number): [number, number, number] {
  const bigX = x / y;
  const bigZ = (1 - x - y) / y;
  return [
    3.2404542 * bigX - 1.5371385 - 0.4985314 * bigZ,
    -0.969266 * bigX + 1.8760108 + 0.041556 * bigZ,
    0.0556434 * bigX - 0.2040259 + 1.0572252 * bigZ,
  ];
}

function referenceKelvinToRgb(kelvin: number): [number, number, number] {
  const xy = PUBLISHED_PLANCKIAN_XY[kelvin];
  const white = PUBLISHED_PLANCKIAN_XY[6500];
  const raw = referenceLinearRgb(xy[0], xy[1]);
  const reference = referenceLinearRgb(white[0], white[1]);
  const balanced = [raw[0] / reference[0], raw[1] / reference[1], raw[2] / reference[2]];
  const peak = Math.max(balanced[0], balanced[1], balanced[2]);
  const scale = peak > 1 ? 1 / peak : 1;
  return [balanced[0] * scale, balanced[1] * scale, balanced[2] * scale];
}

describe('kelvinToRgb', () => {
  // The two implementations agree to 2.2e-3 per channel at worst over these four temperatures, measured,
  // which is the published table's four decimals of chromaticity plus Krystek's approximation error. Two
  // decimals is the nearest standard tolerance above it.
  const TOLERANCE = 0.02;

  it.each([2700, 4500, 6500, 8000])('matches the published locus at %i K', (kelvin) => {
    const actual = kelvinToRgb(kelvin);
    const expected = referenceKelvinToRgb(kelvin);
    expect(actual[0]).toBeCloseTo(expected[0], 2);
    expect(actual[1]).toBeCloseTo(expected[1], 2);
    expect(actual[2]).toBeCloseTo(expected[2], 2);
  });

  it('is white at 6500 K within 0.02 per channel', () => {
    const [r, g, b] = kelvinToRgb(6500);
    expect(Math.abs(r - 1)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(g - 1)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(b - 1)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('is warm at the bottom of the panel range and cool at the top', () => {
    const warm = kelvinToRgb(KELVIN_RANGE[0]);
    const cool = kelvinToRgb(KELVIN_RANGE[1]);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    expect(cool[2]).toBeGreaterThan(cool[0]);
  });

  it('gets steadily bluer as the temperature rises', () => {
    // Blue over red is the ratio a viewer reads as warmth, and it only ever increases.
    let previous = 0;
    for (let kelvin = KELVIN_RANGE[0]; kelvin <= KELVIN_RANGE[1]; kelvin += 100) {
      const [r, , b] = kelvinToRgb(kelvin);
      const ratio = b / r;
      expect(ratio).toBeGreaterThan(previous);
      previous = ratio;
    }
  });

  it('stays inside 0 to 1 across and beyond the panel range', () => {
    for (const kelvin of [0, 500, 1000, 2700, 6500, 8000, 15000, 40000, Number.NaN]) {
      for (const channel of kelvinToRgb(kelvin)) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('candelaToNits', () => {
  it('converts the TopLight: 25 cd on a 4 m by 4 m panel is 1.5625 nits', () => {
    expect(candelaToNits(25, 4, 4)).toBe(1.5625);
  });

  it('converts the KeyLight: 15 cd on 0.6 m by 0.9 m is 27.78 nits', () => {
    // The key light is small and bright, which is why it cannot be given three's default 10 x 10.
    expect(candelaToNits(15, 0.6, 0.9)).toBeCloseTo(27.7778, 4);
  });

  it('is luminance, so halving the area doubles the nits at the same candela', () => {
    expect(candelaToNits(7, 1.5, 1.5)).toBeCloseTo(2 * candelaToNits(7, 1.5, 3), 12);
  });

  it('carries the whole panel range without going negative', () => {
    expect(candelaToNits(CANDELA_RANGE[0], 4, 4)).toBe(0);
    expect(candelaToNits(CANDELA_RANGE[1], 4, 4)).toBe(3.125);
  });

  it('refuses an area of zero rather than returning Infinity', () => {
    expect(() => candelaToNits(25, 0, 4)).toThrow(RangeError);
    expect(() => candelaToNits(25, 4, -1)).toThrow(RangeError);
  });
});

// The axis mapping is derived, not assumed. Unreal's own glTF exporter wrote level-main.glb beside
// lights.json, and the eight point lights and the sun appear in both files, so matching one against the
// other fixes the mapping with no guesswork. The numbers below are what
// `node pipeline/gltf/inspect.mjs assets-src/source/unreal/level-main.glb --json` reports for those nodes,
// quoted here because assets-src/source/unreal/ is not in the repository (.gitignore line 11) and a test
// may not depend on a file a fresh clone does not have.
//
// glTF stores node translations as float32 and lights.json stores doubles, so the comparisons run to five
// decimals: 657 cm converts to 6.57 m and the export carries 6.56999969.
describe('unrealToThreePosition', () => {
  it.each([
    ['BP_PointLightActor_01', [0, 711, 657], [0, 6.56999969, 7.10999966]],
    ['BP_PointLightActor_03', [-712.8, 0, 657], [-7.12799978, 6.56999969, 0]],
    ['BP_PointLightActor_06', [503.629166, -503.62887, 657], [5.0362916, 6.56999969, -5.03628874]],
  ])('lands %s where the level export put it', (_name, locationCm, exported) => {
    const converted = unrealToThreePosition(locationCm as [number, number, number]);
    expect(converted[0]).toBeCloseTo(exported[0], 5);
    expect(converted[1]).toBeCloseTo(exported[1], 5);
    expect(converted[2]).toBeCloseTo(exported[2], 5);
  });

  it('is a swap of the last two axes and a divide by 100, nothing else', () => {
    expect(unrealToThreePosition([100, 200, 300])).toEqual([1, 3, 2]);
  });

  it('flips handedness exactly once, which is what left handed to right handed needs', () => {
    // The determinant of the mapping matrix. One axis swap is one sign flip.
    const x = unrealToThreePosition([1, 0, 0]);
    const y = unrealToThreePosition([0, 1, 0]);
    const z = unrealToThreePosition([0, 0, 1]);
    const determinant =
      x[0] * (y[1] * z[2] - y[2] * z[1]) -
      x[1] * (y[0] * z[2] - y[2] * z[0]) +
      x[2] * (y[0] * z[1] - y[1] * z[0]);
    expect(Math.sign(determinant)).toBe(-1);
  });
});

describe('unrealToThreeDirection', () => {
  it('points the sun where the level export points it', () => {
    // lights.json, actor DirectionalLight, forward. The expected value is where the exported node's own
    // -Z axis ends up once its world rotation is applied: quaternion [0.730436, -0.301119, -0.299927,
    // 0.534634] on node DirectionalLight, times [0, -0.707107, 0, 0.707107] on LightNode_DirectionalLight.
    const converted = unrealToThreeDirection([
      0.6387413386906354, -0.11617802907643715, -0.7605998736573714,
    ]);
    expect(converted[0]).toBeCloseTo(0.638741, 5);
    expect(converted[1]).toBeCloseTo(-0.7606, 5);
    expect(converted[2]).toBeCloseTo(-0.116178, 5);
  });

  it('points the KeyLight where the level export points it', () => {
    const converted = unrealToThreeDirection([
      -0.6459741880212506, 0.645974188021251, -0.40673664307580015,
    ]);
    expect(converted[0]).toBeCloseTo(-0.645974, 5);
    expect(converted[1]).toBeCloseTo(-0.406737, 5);
    expect(converted[2]).toBeCloseTo(0.645974, 5);
  });

  it('normalises whatever it is given', () => {
    const converted = unrealToThreeDirection([0, 0, -3]);
    expect(converted).toEqual([0, -1, 0]);
  });

  it('refuses a zero vector rather than returning NaN', () => {
    expect(() => unrealToThreeDirection([0, 0, 0])).toThrow(RangeError);
  });
});
