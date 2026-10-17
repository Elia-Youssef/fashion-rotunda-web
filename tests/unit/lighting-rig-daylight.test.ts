import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RIG,
  daylightParameters,
  daylightSun,
  updateDaylight,
} from '../../src/lighting/rig';
import { studioLight } from '../support/lighting-rig';

// The Daylight and Atmosphere coordination: the sun parameters across [0, 1], monotonic
// and deterministic, isolated from the three studio lights the visitor edits separately.

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

describe('Daylight kelvin interpolation between anchors', () => {
  it('interpolates linearly between the pinned anchors, not only at them', () => {
    // 0.4 sits between the 4000 K and 6500 K anchors: 4000 + 2500 * 0.8
    expect(daylightParameters(0.4).kelvin).toBe(6000);
    // 0.6 sits between the 6500 K and 7500 K anchors: 6500 + 1000 * 0.2
    expect(daylightParameters(0.6).kelvin).toBe(6700);
  });
});
