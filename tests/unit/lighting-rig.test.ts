import { describe, expect, it } from 'vitest';
import {
  CANDELA_RANGE,
  DAYLIGHT_RANGE,
  DEFAULT_RIG,
  EXPOSURE_RANGE,
  UNREAL_COLORS,
  daylightParameters,
  daylightSun,
  hexToLinearRgb,
  intensityScale,
  kelvinToHex,
  kelvinTintToHex,
  linearRgbToHex,
  normalizeHexColor,
  parseRig,
  serializeRig,
  skyIntensity,
  srgbToLinear,
  sunDirection,
  updateDaylight,
  updateExposure,
  updateLight,
} from '../../src/lighting/rig';
import { kelvinToRgb } from '../../src/lighting/units';
import type { Rig, RigLight, RigStudioLightId } from '../../src/lighting/rig';

function studioLight(rig: Rig, id: RigStudioLightId): RigLight {
  const found = rig.lights.find((entry) => entry.id === id);
  if (!found) throw new Error(`no light ${id} in the rig`);
  return found;
}

describe('DEFAULT_RIG', () => {
  it('carries exactly three studio lights: Key, Fill, Back', () => {
    expect(DEFAULT_RIG.lights.map((entry) => entry.id)).toEqual(['key', 'fill', 'back']);
    expect(DEFAULT_RIG.lights.map((entry) => entry.label)).toEqual(['KeyLight', 'FillLight', 'BackLight']);
  });

  it('contains zero Top or Indirect lights in the active rig', () => {
    const ids = DEFAULT_RIG.lights.map((entry) => entry.id);
    expect(ids).not.toContain('top');
    expect(ids).not.toContain('indirect');
  });

  it('starts at daylight 0.5 (neutral Day) and exposure 1', () => {
    expect(DEFAULT_RIG.daylight).toBe(0.5);
    expect(DEFAULT_RIG.exposure).toBe(1);
  });

  it('provides candela intensity scale for rect lights', () => {
    expect(intensityScale('rect')).toEqual({ range: CANDELA_RANGE, step: 0.5, unit: 'cd' });
  });

  it('puts KeyLight at [2, 2.8, -2] metres: 15 cd, #ffffff, aimed down and inward', () => {
    const key = studioLight(DEFAULT_RIG, 'key');
    expect(key.kind).toBe('rect');
    expect(key.on).toBe(true);
    expect(key.intensity).toBe(15);
    expect(key.color).toBe('#ffffff');
    expect(key.position?.[0]).toBeCloseTo(2, 6);
    expect(key.position?.[1]).toBeCloseTo(2.8, 6);
    expect(key.position?.[2]).toBeCloseTo(-2, 6);
    expect(key.size?.[0]).toBeCloseTo(0.6, 6);
    expect(key.size?.[1]).toBeCloseTo(0.9, 6);
    expect(key.direction?.[0]).toBeCloseTo(-0.645974, 5);
    expect(key.direction?.[1]).toBeCloseTo(-0.406737, 5);
    expect(key.direction?.[2]).toBeCloseTo(0.645974, 5);
    expect(key.castShadow).toBe(false);
  });

  it('puts FillLight at [-2.15, 2.8, -2.3] metres: 7 cd, #ffffff, starting off', () => {
    const fill = studioLight(DEFAULT_RIG, 'fill');
    expect(fill.kind).toBe('rect');
    expect(fill.on).toBe(false);
    expect(fill.intensity).toBe(7);
    expect(fill.color).toBe('#ffffff');
    expect(fill.position?.[0]).toBeCloseTo(-2.15, 6);
    expect(fill.position?.[1]).toBeCloseTo(2.8, 6);
    expect(fill.position?.[2]).toBeCloseTo(-2.3, 6);
    expect(fill.size).toEqual([1.5, 1.5]);
    expect(fill.castShadow).toBe(false);
  });

  it('puts BackLight at [0.05, 3, 3.3] metres: 7 cd, #ffffff, starting off', () => {
    const back = studioLight(DEFAULT_RIG, 'back');
    expect(back.kind).toBe('rect');
    expect(back.on).toBe(false);
    expect(back.intensity).toBe(7);
    expect(back.color).toBe('#ffffff');
    expect(back.position?.[0]).toBeCloseTo(0.05, 6);
    expect(back.position?.[1]).toBeCloseTo(3, 6);
    expect(back.position?.[2]).toBeCloseTo(3.3, 6);
    expect(back.size).toEqual([1.5, 1.5]);
    expect(back.castShadow).toBe(false);
  });
});

describe('Daylight and Atmosphere Coordination', () => {
  it('reproduces the Unreal reference values at d = 0.5, with a neutral white 6500 K sun', () => {
    // Unreal authors the sun at 7000 K (#f3f8ff); the web default is 6500 K white by client decision
    // on 2026-09-23.
    const ref = daylightParameters(0.5);
    expect(ref.angleDeg).toBeCloseTo(130.4829, 3);
    expect(ref.intensity).toBe(7.0);
    expect(ref.kelvin).toBe(6500);
    expect(ref.color).toBe('#ffffff');
    expect(ref.skyIntensity).toBe(2.0);
    expect(ref.backgroundIntensity).toBe(0.25);
    expect(ref.exposure).toBe(1.0);

    // Direction matches the established web conversion of Unreal sun forward
    expect(ref.direction[0]).toBeCloseTo(0.6387, 3);
    expect(ref.direction[1]).toBeCloseTo(-0.7606, 3);
    expect(ref.direction[2]).toBeCloseTo(-0.1162, 3);
  });

  it('coordinates sun intensity, color, sky, and exposure across [0, 1]', () => {
    const min = daylightParameters(0.0);
    const ref = daylightParameters(0.5);
    const max = daylightParameters(1.0);

    // Sun intensity increases smoothly: 2.0 -> 7.0 -> 12.0 lux
    expect(min.intensity).toBe(2.0);
    expect(ref.intensity).toBe(7.0);
    expect(max.intensity).toBe(12.0);

    // Color temperature: warm 4000 K -> neutral white 6500 K -> crisp 7500 K, piecewise linear
    expect(min.kelvin).toBe(4000);
    expect(min.color).toBe('#ffd9a6');
    expect(daylightParameters(0.25).kelvin).toBe(5250);
    expect(ref.kelvin).toBe(6500);
    expect(ref.color).toBe('#ffffff');
    expect(daylightParameters(0.75).kelvin).toBe(7000);
    expect(max.kelvin).toBe(7500);
    expect(max.color).toBe('#eaf2ff');

    // Sky ambient increases more gently than direct sun: 1.0 -> 2.0 -> 2.6
    expect(min.skyIntensity).toBe(1.0);
    expect(ref.skyIntensity).toBe(2.0);
    expect(max.skyIntensity).toBe(2.6);

    // Background intensity is visually related: 0.15 -> 0.25 -> 0.30
    expect(min.backgroundIntensity).toBe(0.15);
    expect(ref.backgroundIntensity).toBe(0.25);
    expect(max.backgroundIntensity).toBe(0.30);

    // Coordinated exposure prevents highlight clipping: 1.10 -> 1.00 -> 0.90
    expect(min.exposure).toBe(1.10);
    expect(ref.exposure).toBe(1.00);
    expect(max.exposure).toBe(0.90);
  });

  it('maintains strict monotonicity and continuity across [0, 1]', () => {
    let prevIntensity = -1;
    let prevKelvin = -1;
    let prevSky = -1;
    let prevBg = -1;
    let prevExposure = 999;

    for (let step = 0; step <= 20; step += 1) {
      const d = step / 20;
      const params = daylightParameters(d);

      expect(Number.isFinite(params.intensity)).toBe(true);
      expect(Number.isFinite(params.kelvin)).toBe(true);
      expect(Number.isFinite(params.skyIntensity)).toBe(true);
      expect(Number.isFinite(params.backgroundIntensity)).toBe(true);
      expect(Number.isFinite(params.exposure)).toBe(true);

      expect(params.intensity).toBeGreaterThanOrEqual(prevIntensity);
      expect(params.kelvin).toBeGreaterThanOrEqual(prevKelvin);
      expect(params.skyIntensity).toBeGreaterThanOrEqual(prevSky);
      expect(params.backgroundIntensity).toBeGreaterThanOrEqual(prevBg);
      expect(params.exposure).toBeLessThanOrEqual(prevExposure);

      expect(params.exposure).toBeGreaterThanOrEqual(0.90);
      expect(params.exposure).toBeLessThanOrEqual(1.10);

      prevIntensity = params.intensity;
      prevKelvin = params.kelvin;
      prevSky = params.skyIntensity;
      prevBg = params.backgroundIntensity;
      prevExposure = params.exposure;
    }

    // No discontinuity around reference anchor
    const justBefore = daylightParameters(0.499);
    const justAfter = daylightParameters(0.501);
    const anchor = daylightParameters(0.5);
    expect(justBefore.intensity).toBeCloseTo(anchor.intensity, 1);
    expect(justAfter.intensity).toBeCloseTo(anchor.intensity, 1);
    expect(justBefore.exposure).toBeCloseTo(anchor.exposure, 2);
    expect(justAfter.exposure).toBeCloseTo(anchor.exposure, 2);
  });

  it('normalizes out-of-range, NaN, and Infinity inputs safely', () => {
    const under = daylightParameters(-10);
    expect(under).toEqual(daylightParameters(0.0));

    const over = daylightParameters(10);
    expect(over).toEqual(daylightParameters(1.0));

    const nan = daylightParameters(Number.NaN);
    expect(nan).toEqual(daylightParameters(0.5));

    const posInf = daylightParameters(Number.POSITIVE_INFINITY);
    expect(posInf).toEqual(daylightParameters(1.0));

    const negInf = daylightParameters(Number.NEGATIVE_INFINITY);
    expect(negInf).toEqual(daylightParameters(0.0));
  });

  it('is completely deterministic and idempotent without state accumulation', () => {
    const first = daylightParameters(0.35);
    const second = daylightParameters(0.35);
    expect(first).toEqual(second);

    // Repeated updateDaylight preserves idempotence
    let rig = DEFAULT_RIG;
    rig = updateDaylight(rig, 0.2);
    rig = updateDaylight(rig, 0.8);
    rig = updateDaylight(rig, 0.5);
    expect(rig.daylight).toBe(0.5);
    expect(rig.exposure).toBe(1.0);
  });

  it('daylightSun returns consistent parameters matching daylightParameters', () => {
    const sun = daylightSun(0.5);
    expect(sun).toEqual(daylightParameters(0.5));
  });

  it('skyIntensity reads the rig daylight property', () => {
    expect(skyIntensity(DEFAULT_RIG)).toBe(2.0);
    const minRig = updateDaylight(DEFAULT_RIG, 0.0);
    expect(skyIntensity(minRig)).toBe(1.0);
    const maxRig = updateDaylight(DEFAULT_RIG, 1.0);
    expect(skyIntensity(maxRig)).toBe(2.6);
  });

  it('sunDirection produces unit vectors for any valid degree', () => {
    for (const deg of [0, 15, 45, 90, 130.483, 135, 180]) {
      const dir = sunDirection(deg);
      const len = Math.hypot(dir[0], dir[1], dir[2]);
      expect(len).toBeCloseTo(1, 6);
    }
  });

  it('isolates the three-point studio rig: daylight sweeps never alter Key, Fill, or Rim', () => {
    for (const d of [0.0, 0.1, 0.5, 0.9, 1.0]) {
      const rig = updateDaylight(DEFAULT_RIG, d);
      expect(studioLight(rig, 'key')).toEqual(studioLight(DEFAULT_RIG, 'key'));
      expect(studioLight(rig, 'fill')).toEqual(studioLight(DEFAULT_RIG, 'fill'));
      expect(studioLight(rig, 'back')).toEqual(studioLight(DEFAULT_RIG, 'back'));
      expect(rig.lights.every((l) => l.castShadow === false)).toBe(true);
    }
  });
});

describe('Immutable Rig Operations', () => {
  it('updateLight updates on, intensity, and color immutably', () => {
    const updated = updateLight(DEFAULT_RIG, 'key', {
      on: false,
      intensity: 22.5,
      color: '#ff00aa',
    });

    expect(updated).not.toBe(DEFAULT_RIG);
    expect(updated.lights).not.toBe(DEFAULT_RIG.lights);
    const key = studioLight(updated, 'key');
    expect(key.on).toBe(false);
    expect(key.intensity).toBe(22.5);
    expect(key.color).toBe('#ff00aa');

    // Untouched lights preserved
    expect(studioLight(updated, 'fill')).toEqual(studioLight(DEFAULT_RIG, 'fill'));
    expect(studioLight(updated, 'back')).toEqual(studioLight(DEFAULT_RIG, 'back'));
  });

  it('clamps intensity to CANDELA_RANGE', () => {
    const under = updateLight(DEFAULT_RIG, 'key', { intensity: -10 });
    expect(studioLight(under, 'key').intensity).toBe(CANDELA_RANGE[0]);

    const over = updateLight(DEFAULT_RIG, 'key', { intensity: 100 });
    expect(studioLight(over, 'key').intensity).toBe(CANDELA_RANGE[1]);
  });

  it('normalizes NaN and Infinity intensity to finite bounds, never negative', () => {
    const nan = updateLight(DEFAULT_RIG, 'key', { intensity: Number.NaN });
    expect(studioLight(nan, 'key').intensity).toBe(CANDELA_RANGE[0]);

    const positiveInfinity = updateLight(DEFAULT_RIG, 'key', { intensity: Number.POSITIVE_INFINITY });
    expect(studioLight(positiveInfinity, 'key').intensity).toBe(CANDELA_RANGE[1]);

    const negativeInfinity = updateLight(DEFAULT_RIG, 'key', { intensity: Number.NEGATIVE_INFINITY });
    expect(studioLight(negativeInfinity, 'key').intensity).toBe(CANDELA_RANGE[0]);

    // Zero stays a valid control value, not a fallback
    const zero = updateLight(DEFAULT_RIG, 'key', { intensity: 0 });
    expect(studioLight(zero, 'key').intensity).toBe(0);
  });

  it('keeps disabled lights retaining their configured intensity and color', () => {
    // Fill and Back default off but hold their default intensity and color in state
    const fill = studioLight(DEFAULT_RIG, 'fill');
    expect(fill.on).toBe(false);
    expect(fill.intensity).toBe(7);
    expect(fill.color).toBe('#ffffff');
    const back = studioLight(DEFAULT_RIG, 'back');
    expect(back.on).toBe(false);
    expect(back.intensity).toBe(7);
    expect(back.color).toBe('#ffffff');

    // Toggling does not destructively reset anything: enabling restores retained values
    const fillOn = updateLight(DEFAULT_RIG, 'fill', { on: true });
    expect(studioLight(fillOn, 'fill').on).toBe(true);
    expect(studioLight(fillOn, 'fill').intensity).toBe(7);
    expect(studioLight(fillOn, 'fill').color).toBe('#ffffff');

    // Customized values survive an off/on round trip
    let rig = updateLight(DEFAULT_RIG, 'back', { on: true, intensity: 12.5, color: '#123456' });
    rig = updateLight(rig, 'back', { on: false });
    rig = updateLight(rig, 'back', { on: true });
    const restored = studioLight(rig, 'back');
    expect(restored.on).toBe(true);
    expect(restored.intensity).toBe(12.5);
    expect(restored.color).toBe('#123456');
  });

  it('updateDaylight clamps to [0, 1]', () => {
    const min = updateDaylight(DEFAULT_RIG, -0.5);
    expect(min.daylight).toBe(DAYLIGHT_RANGE[0]);

    const max = updateDaylight(DEFAULT_RIG, 2.5);
    expect(max.daylight).toBe(DAYLIGHT_RANGE[1]);
  });

  it('updateExposure clamps to EXPOSURE_RANGE', () => {
    const low = updateExposure(DEFAULT_RIG, 0.01);
    expect(low.exposure).toBe(EXPOSURE_RANGE[0]);

    const high = updateExposure(DEFAULT_RIG, 20);
    expect(high.exposure).toBe(EXPOSURE_RANGE[1]);
  });
});

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

describe('Serialization and Backward Compatibility Migration', () => {
  it('serializes to v2 format with hex without #', () => {
    const text = serializeRig(DEFAULT_RIG);
    expect(text.startsWith('v2;')).toBe(true);
    expect(text).toBe('v2;key,1,15,ffffff;fill,0,7,ffffff;back,0,7,ffffff;day,0.5');
    // Exposure is omitted when equal to default
    expect(text).not.toContain(';e,');
    // Ensure no '#' in serialized rig for safe query string usage
    expect(text).not.toContain('#');
  });

  it('restores the explicit colours of an old share link written with the Unreal-authored defaults', () => {
    const old = parseRig('v2;key,1,15,bcc8bd;fill,0,7,b3dbff;back,0,7,bce1ff;day,0.5', DEFAULT_RIG);
    expect(studioLight(old, 'key').color).toBe('#bcc8bd');
    expect(studioLight(old, 'fill').color).toBe('#b3dbff');
    expect(studioLight(old, 'back').color).toBe('#bce1ff');
    expect(old.daylight).toBe(0.5);
    expect(old.exposure).toBe(1);
    expect(serializeRig(old)).toBe('v2;key,1,15,bcc8bd;fill,0,7,b3dbff;back,0,7,bce1ff;day,0.5');
  });

  it('omits exposure e on DEFAULT_RIG but includes e when exposure differs from default', () => {
    const defaultText = serializeRig(DEFAULT_RIG);
    expect(defaultText).not.toContain(';e,');

    // Daylight change coordinates exposure to 0.93 (at d = 0.85)
    const daylightChanged = updateDaylight(DEFAULT_RIG, 0.85);
    const daylightText = serializeRig(daylightChanged);
    expect(daylightText).toContain('day,0.85;e,0.93');

    // Manual exposure change
    const manualExposure = updateExposure(DEFAULT_RIG, 1.25);
    const manualText = serializeRig(manualExposure);
    expect(manualText).toContain('day,0.5;e,1.25');

    // Both round-trip cleanly through parseRig
    const parsedDaylight = parseRig(daylightText, DEFAULT_RIG);
    expect(parsedDaylight.daylight).toBe(0.85);
    expect(parsedDaylight.exposure).toBe(0.93);

    const parsedManual = parseRig(manualText, DEFAULT_RIG);
    expect(parsedManual.daylight).toBe(0.5);
    expect(parsedManual.exposure).toBe(1.25);
  });

  it('round-trips customized rigs cleanly in v2 format', () => {
    let rig = updateLight(DEFAULT_RIG, 'key', { on: false, intensity: 30, color: '#112233' });
    rig = updateLight(rig, 'fill', { on: true, intensity: 12.5, color: '#445566' });
    rig = updateDaylight(rig, 0.85);

    const serialized = serializeRig(rig);
    const parsed = parseRig(serialized, DEFAULT_RIG);

    expect(studioLight(parsed, 'key').on).toBe(false);
    expect(studioLight(parsed, 'key').intensity).toBe(30);
    expect(studioLight(parsed, 'key').color).toBe('#112233');

    expect(studioLight(parsed, 'fill').on).toBe(true);
    expect(studioLight(parsed, 'fill').intensity).toBe(12.5);
    expect(studioLight(parsed, 'fill').color).toBe('#445566');

    expect(parsed.daylight).toBe(0.85);
    expect(parsed.exposure).toBe(0.93);
  });

  it('explicitly migrates legacy v1 rigs without error', () => {
    const v1Text =
      'v1;top,1,25,6500;key,1,18,4500;fill,1,10,7000;back,0,7,6500;indirect,1,5,5000;sun,1,7,7000,130.483;sky,1,2,6500;e,1';

    const migrated = parseRig(v1Text, DEFAULT_RIG);

    // Key, Fill, Back migrated
    expect(studioLight(migrated, 'key').intensity).toBe(18);
    expect(studioLight(migrated, 'key').color).toBe('#ffe3bd');

    expect(studioLight(migrated, 'fill').on).toBe(true);
    expect(studioLight(migrated, 'fill').intensity).toBe(10);
    expect(studioLight(migrated, 'fill').color).toBe('#f3f8ff');

    // Sun angle (130.483) mapped to daylight
    expect(migrated.daylight).toBeCloseTo((130.483 - 15) / 150, 2);

    // Rig has exactly 3 studio lights
    expect(migrated.lights).toHaveLength(3);
    expect(migrated.lights.map((l) => l.id)).toEqual(['key', 'fill', 'back']);
  });

  it('never reinterprets removed Top or Indirect lights from v1 as other lights', () => {
    // A v1 rig with modified top and indirect lights
    const v1Text =
      'v1;top,0,0,2700;key,1,15,4500;fill,0,7,7000;back,0,7,6500;indirect,0,0,2700;sun,1,7,7000,90;sky,1,2,6500;e,1';

    const migrated = parseRig(v1Text, DEFAULT_RIG);

    // Key, Fill, Back must NOT have inherited top or indirect values
    expect(studioLight(migrated, 'key').intensity).toBe(15);
    expect(studioLight(migrated, 'key').on).toBe(true);
    expect(studioLight(migrated, 'fill').intensity).toBe(7);
    expect(studioLight(migrated, 'back').intensity).toBe(7);

    // No top or indirect exists in the resulting rig
    expect(migrated.lights.some((l) => (l.id as string) === 'top')).toBe(false);
    expect(migrated.lights.some((l) => (l.id as string) === 'indirect')).toBe(false);
  });

  it('returns base rig on malformed or empty inputs', () => {
    expect(parseRig('', DEFAULT_RIG)).toBe(DEFAULT_RIG);
    expect(parseRig('unknown-format;abc', DEFAULT_RIG)).toBe(DEFAULT_RIG);
  });
});
