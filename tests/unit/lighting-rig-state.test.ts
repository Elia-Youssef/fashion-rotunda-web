import { describe, expect, it } from 'vitest';
import {
  CANDELA_RANGE,
  DAYLIGHT_RANGE,
  DAYLIGHT_STEP,
  DEFAULT_RIG,
  EXPOSURE_RANGE,
  updateDaylight,
  updateExposure,
  updateLight,
} from '../../src/lighting/rig';
import { studioLight } from '../support/lighting-rig';

// The rig data: the default three-light rig, its published control constants, its
// deep-frozen shape, and the immutable update operations with their clamps and
// bad-input fallbacks.

describe('DEFAULT_RIG', () => {
  it('carries exactly three studio lights: Key, Fill, Back', () => {
    expect(DEFAULT_RIG.lights.map((entry) => entry.id)).toEqual(['key', 'fill', 'back']);
    expect(DEFAULT_RIG.lights.map((entry) => entry.label)).toEqual(['Key light', 'Fill light', 'Back light']);
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

describe('Published control constants', () => {
  it('pins the daylight step at 1 percent and the exposure range at [0.05, 8]', () => {
    // Numeric pins. The suites that read these symbols (clamp bounds here, the
    // range input step in the DOM suite) read the same constant, so a symbolic
    // comparison cannot catch a changed number.
    expect(DAYLIGHT_STEP).toBe(0.01);
    expect(EXPOSURE_RANGE).toEqual([0.05, 8]);
  });
});

describe('DEFAULT_RIG immutability', () => {
  it('is deep-frozen: the rig, the lights array, every light and its tuples', () => {
    expect(Object.isFrozen(DEFAULT_RIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_RIG.lights)).toBe(true);
    for (const light of DEFAULT_RIG.lights) {
      expect(Object.isFrozen(light)).toBe(true);
      expect(Object.isFrozen(light.position)).toBe(true);
      expect(Object.isFrozen(light.direction)).toBe(true);
      expect(Object.isFrozen(light.size)).toBe(true);
    }
  });
});

describe('Rig updates on bad input', () => {
  it('an invalid color patch keeps the current color of the light', () => {
    const tinted = updateLight(DEFAULT_RIG, 'key', { color: '#123456' });
    const kept = updateLight(tinted, 'key', { color: 'not-a-color' });
    expect(studioLight(kept, 'key').color).toBe('#123456');
  });

  it('updateLight preserves the rig daylight and exposure it was given', () => {
    const moved = updateDaylight(DEFAULT_RIG, 0.85); // daylight 0.85, exposure 0.93
    const changed = updateLight(moved, 'key', { intensity: 20 });
    expect(changed.daylight).toBe(0.85);
    expect(changed.exposure).toBe(0.93);
  });

  it('updateDaylight falls back to 0.5 (neutral Day) on NaN', () => {
    const moved = updateDaylight(DEFAULT_RIG, 0.85);
    const reset = updateDaylight(moved, Number.NaN);
    expect(reset.daylight).toBe(0.5);
    expect(reset.exposure).toBe(1.0);
  });

  it('updateExposure falls back to 1 on NaN and both infinities, not to a range bound', () => {
    const opened = updateExposure(DEFAULT_RIG, 2);
    expect(updateExposure(opened, Number.NaN).exposure).toBe(1);
    expect(updateExposure(opened, Number.POSITIVE_INFINITY).exposure).toBe(1);
    expect(updateExposure(opened, Number.NEGATIVE_INFINITY).exposure).toBe(1);
  });
});
