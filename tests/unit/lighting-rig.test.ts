import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RIG,
  EXPOSURE_RANGE,
  INDIRECT_DISTANCE_M,
  intensityScale,
  parseRig,
  serializeRig,
  skyIntensity,
  sunDirection,
  updateExposure,
  updateLight,
} from '../../src/lighting/rig';
import type { Rig, RigLight } from '../../src/lighting/rig';
import { CANDELA_RANGE, KELVIN_RANGE, SUN_ANGLE_RANGE, SUN_LUX_RANGE } from '../../src/lighting/units';

function light(rig: Rig, id: RigLight['id']): RigLight {
  const found = rig.lights.find((entry) => entry.id === id);
  if (!found) throw new Error(`no light ${id} in the rig`);
  return found;
}

// Every expected number below is the Unreal value from assets-src/source/unreal/lights.json converted by
// hand: centimetres divided by 100, and the Unreal (x, y, z) read out as three's (x, z, y).
describe('DEFAULT_RIG', () => {
  it('carries the seven lights in panel order', () => {
    expect(DEFAULT_RIG.lights.map((entry) => entry.id)).toEqual([
      'top',
      'key',
      'fill',
      'back',
      'indirect',
      'sun',
      'sky',
    ]);
    expect(DEFAULT_RIG.lights.map((entry) => entry.label)).toEqual([
      'TopLight',
      'KeyLight',
      'FillLight',
      'BackLight',
      'IndirectLight',
      'Sun',
      'Sky',
    ]);
  });

  it('starts at exposure 1, ready to be tuned', () => {
    expect(DEFAULT_RIG.exposure).toBe(1);
  });

  it('puts TopLight at 0, 6, 0 metres: 25 cd, 6500 K, a 4 m square facing straight down', () => {
    const top = light(DEFAULT_RIG, 'top');
    expect(top.kind).toBe('rect');
    expect(top.on).toBe(true);
    expect(top.intensity).toBe(25);
    expect(top.kelvin).toBe(6500);
    expect(top.position?.[0]).toBeCloseTo(0, 9);
    expect(top.position?.[1]).toBeCloseTo(6, 9);
    expect(top.position?.[2]).toBeCloseTo(0, 9);
    expect(top.size).toEqual([4, 4]);
    expect(top.direction?.[1]).toBeCloseTo(-1, 9);
    expect(top.castShadow).toBe(false);
  });

  it('puts KeyLight at 2, 2.8, -2 metres: 15 cd, 4500 K, 0.6 by 0.9, aimed down and inward', () => {
    const key = light(DEFAULT_RIG, 'key');
    expect(key.on).toBe(true);
    expect(key.intensity).toBe(15);
    expect(key.kelvin).toBe(4500);
    expect(key.position?.[0]).toBeCloseTo(2, 9);
    expect(key.position?.[1]).toBeCloseTo(2.8, 9);
    expect(key.position?.[2]).toBeCloseTo(-2, 9);
    expect(key.size?.[0]).toBeCloseTo(0.6, 9);
    expect(key.size?.[1]).toBeCloseTo(0.9, 9);
    // Unreal forward (-0.645974, 0.645974, -0.406737) read as three (x, z, y).
    expect(key.direction?.[0]).toBeCloseTo(-0.645974, 6);
    expect(key.direction?.[1]).toBeCloseTo(-0.406737, 6);
    expect(key.direction?.[2]).toBeCloseTo(0.645974, 6);
  });

  it('puts FillLight at -2.15, 2.8, -2.3 metres and starts it off, as the level does', () => {
    const fill = light(DEFAULT_RIG, 'fill');
    expect(fill.on).toBe(false);
    expect(fill.intensity).toBe(7);
    expect(fill.kelvin).toBe(7000);
    expect(fill.position?.[0]).toBeCloseTo(-2.15, 9);
    expect(fill.position?.[1]).toBeCloseTo(2.8, 9);
    expect(fill.position?.[2]).toBeCloseTo(-2.3, 9);
    expect(fill.size).toEqual([1.5, 1.5]);
  });

  it('puts BackLight at 0.05, 3, 3.3 metres and starts it off, as the level does', () => {
    const back = light(DEFAULT_RIG, 'back');
    expect(back.on).toBe(false);
    expect(back.intensity).toBe(7);
    expect(back.kelvin).toBe(6500);
    expect(back.position?.[0]).toBeCloseTo(0.05, 9);
    expect(back.position?.[1]).toBeCloseTo(3, 9);
    expect(back.position?.[2]).toBeCloseTo(3.3, 9);
    expect(back.direction?.[1]).toBeCloseTo(-0.406737, 6);
    expect(back.direction?.[2]).toBeCloseTo(-0.913545, 6);
  });

  it('rings IndirectLight with eight point lights at 6.57 m, 5 cd, 5000 K', () => {
    const indirect = light(DEFAULT_RIG, 'indirect');
    expect(indirect.kind).toBe('point');
    expect(indirect.on).toBe(true);
    expect(indirect.intensity).toBe(5);
    expect(indirect.kelvin).toBe(5000);
    expect(indirect.members).toHaveLength(8);
    expect(indirect.position?.[1]).toBeCloseTo(6.57, 9);
    for (const member of indirect.members ?? []) {
      expect(member[1]).toBeCloseTo(6.57, 9);
    }
    // Members 1, 3 and 6, the three the axis mapping was pinned against in lighting-units.test.ts.
    expect(indirect.members?.[0][0]).toBeCloseTo(0, 9);
    expect(indirect.members?.[0][2]).toBeCloseTo(7.11, 9);
    expect(indirect.members?.[2][0]).toBeCloseTo(-7.128, 9);
    expect(indirect.members?.[2][2]).toBeCloseTo(0, 9);
    expect(indirect.members?.[5][0]).toBeCloseTo(5.03629166, 9);
    expect(indirect.members?.[5][2]).toBeCloseTo(-5.0362887, 9);
    // The ring is not a perfect circle in the level and is kept as authored.
    const radii = (indirect.members ?? []).map((member) => Math.hypot(member[0], member[2]));
    expect(Math.min(...radii)).toBeCloseTo(7.11, 6);
    expect(Math.max(...radii)).toBeCloseTo(7.128, 6);
    expect(INDIRECT_DISTANCE_M).toBe(10);
  });

  it('sets the sun to 7 lux, 7000 K, on the arc where the Unreal sun already stands', () => {
    const sun = light(DEFAULT_RIG, 'sun');
    expect(sun.kind).toBe('sun');
    expect(sun.intensity).toBe(7);
    expect(sun.kelvin).toBe(7000);
    expect(sun.castShadow).toBe(true);
    // Unreal pitch -49.517 degrees, so 49.517 above the horizon on the far side: 180 - 49.517.
    expect(sun.sunAngleDeg).toBeCloseTo(130.483, 3);
    // Unreal forward (0.638741, -0.116178, -0.7606) read as three (x, z, y). The angle is stored to three
    // decimals so a URL round trips exactly, which costs 1e-5 against the raw export.
    expect(sun.direction?.[0]).toBeCloseTo(0.638741, 4);
    expect(sun.direction?.[1]).toBeCloseTo(-0.7606, 4);
    expect(sun.direction?.[2]).toBeCloseTo(-0.116178, 4);
  });

  it('carries the sky as a scale with no position and no direction', () => {
    const sky = light(DEFAULT_RIG, 'sky');
    expect(sky.kind).toBe('sky');
    expect(sky.on).toBe(true);
    expect(sky.intensity).toBe(2);
    expect(sky.position).toBeUndefined();
    expect(sky.direction).toBeUndefined();
  });

  it('is frozen, so nothing downstream can edit the default out from under the rest', () => {
    expect(Object.isFrozen(DEFAULT_RIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_RIG.lights)).toBe(true);
    expect(Object.isFrozen(light(DEFAULT_RIG, 'top'))).toBe(true);
  });

  it('holds only values its own controls could have produced', () => {
    for (const entry of DEFAULT_RIG.lights) {
      const scale = intensityScale(entry.kind);
      expect(entry.intensity).toBeGreaterThanOrEqual(scale.range[0]);
      expect(entry.intensity).toBeLessThanOrEqual(scale.range[1]);
      expect(entry.kelvin).toBeGreaterThanOrEqual(KELVIN_RANGE[0]);
      expect(entry.kelvin).toBeLessThanOrEqual(KELVIN_RANGE[1]);
    }
  });
});

describe('sunDirection', () => {
  it('shines straight down from the zenith at 90 degrees', () => {
    const direction = sunDirection(90);
    expect(direction[0]).toBeCloseTo(0, 9);
    expect(direction[1]).toBeCloseTo(-1, 9);
    expect(direction[2]).toBeCloseTo(0, 9);
  });

  it('shines horizontally at both ends of the arc, from opposite sides', () => {
    const east = sunDirection(SUN_ANGLE_RANGE[0]);
    const west = sunDirection(SUN_ANGLE_RANGE[1]);
    expect(east[1]).toBeCloseTo(0, 9);
    expect(west[1]).toBeCloseTo(0, 9);
    expect(east[0]).toBeCloseTo(-west[0], 9);
    expect(east[2]).toBeCloseTo(-west[2], 9);
    // 0 is the east end, so the light travels west from it: its x is negative.
    expect(east[0]).toBeLessThan(0);
  });

  it('returns a unit vector at every angle and clamps outside the arc', () => {
    for (let angle = -90; angle <= 270; angle += 5) {
      const direction = sunDirection(angle);
      expect(Math.hypot(direction[0], direction[1], direction[2])).toBeCloseTo(1, 9);
      expect(direction[1]).toBeLessThanOrEqual(1e-12);
    }
  });
});

describe('updateLight', () => {
  it('returns a new rig and leaves the old one untouched', () => {
    const next = updateLight(DEFAULT_RIG, 'key', { kelvin: 5000 });
    expect(next).not.toBe(DEFAULT_RIG);
    expect(light(next, 'key').kelvin).toBe(5000);
    expect(light(DEFAULT_RIG, 'key').kelvin).toBe(4500);
  });

  it('shares the lights it did not touch, so a change costs one object', () => {
    const next = updateLight(DEFAULT_RIG, 'key', { on: false });
    expect(light(next, 'top')).toBe(light(DEFAULT_RIG, 'top'));
    expect(light(next, 'key')).not.toBe(light(DEFAULT_RIG, 'key'));
  });

  it('clamps intensity to the range for that kind of light', () => {
    expect(light(updateLight(DEFAULT_RIG, 'top', { intensity: 999 }), 'top').intensity).toBe(
      CANDELA_RANGE[1],
    );
    expect(light(updateLight(DEFAULT_RIG, 'top', { intensity: -5 }), 'top').intensity).toBe(
      CANDELA_RANGE[0],
    );
    expect(light(updateLight(DEFAULT_RIG, 'sun', { intensity: 999 }), 'sun').intensity).toBe(
      SUN_LUX_RANGE[1],
    );
  });

  it('clamps temperature to the panel range', () => {
    expect(light(updateLight(DEFAULT_RIG, 'key', { kelvin: 100 }), 'key').kelvin).toBe(KELVIN_RANGE[0]);
    expect(light(updateLight(DEFAULT_RIG, 'key', { kelvin: 99000 }), 'key').kelvin).toBe(KELVIN_RANGE[1]);
  });

  it('recomputes the sun direction whenever the angle moves', () => {
    const next = updateLight(DEFAULT_RIG, 'sun', { sunAngleDeg: 90 });
    const sun = light(next, 'sun');
    expect(sun.sunAngleDeg).toBe(90);
    expect(sun.direction?.[1]).toBeCloseTo(-1, 9);
  });

  it('ignores a direction written straight onto the sun: the angle is the one source of truth', () => {
    const next = updateLight(DEFAULT_RIG, 'sun', { direction: [1, 0, 0] });
    expect(light(next, 'sun').direction).toEqual(light(DEFAULT_RIG, 'sun').direction);
  });

  it('changes nothing when the patch is empty', () => {
    const next = updateLight(DEFAULT_RIG, 'top', {});
    expect(next.lights).toEqual(DEFAULT_RIG.lights);
  });
});

describe('updateExposure', () => {
  it('replaces the exposure and clamps it', () => {
    expect(updateExposure(DEFAULT_RIG, 1.8).exposure).toBe(1.8);
    expect(updateExposure(DEFAULT_RIG, 500).exposure).toBe(EXPOSURE_RANGE[1]);
    expect(updateExposure(DEFAULT_RIG, 0).exposure).toBe(EXPOSURE_RANGE[0]);
    expect(updateExposure(DEFAULT_RIG, 1.8).lights).toBe(DEFAULT_RIG.lights);
  });
});

describe('skyIntensity', () => {
  it('is the sky entry when it is on', () => {
    expect(skyIntensity(DEFAULT_RIG)).toBe(2);
  });

  it('is zero when the sky is off, so switching it off removes the environment light', () => {
    expect(skyIntensity(updateLight(DEFAULT_RIG, 'sky', { on: false }))).toBe(0);
  });
});

describe('intensityScale', () => {
  it('states candela for the rect and point lights, lux for the sun, a scale for the sky', () => {
    expect(intensityScale('rect')).toEqual({ range: CANDELA_RANGE, step: 0.5, unit: 'cd' });
    expect(intensityScale('point')).toEqual({ range: CANDELA_RANGE, step: 0.5, unit: 'cd' });
    expect(intensityScale('sun')).toEqual({ range: SUN_LUX_RANGE, step: 0.5, unit: 'lx' });
    expect(intensityScale('sky')).toEqual({ range: [0, 4], step: 0.1, unit: 'scale' });
  });
});

describe('serializeRig and parseRig', () => {
  it('writes the default rig as one URL safe line', () => {
    expect(serializeRig(DEFAULT_RIG)).toBe(
      'v1;top,1,25,6500;key,1,15,4500;fill,0,7,7000;back,0,7,6500;indirect,1,5,5000;' +
        'sun,1,7,7000,130.483;sky,1,2,6500;e,1',
    );
  });

  it('uses only characters a query string carries unescaped', () => {
    const text = serializeRig(DEFAULT_RIG);
    expect(encodeURIComponent(text).replace(/%2C/g, ',').replace(/%3B/g, ';')).toBe(text);
  });

  it('round trips a rig that every control has been moved on', () => {
    let rig = updateLight(DEFAULT_RIG, 'top', { on: false, intensity: 12.5, kelvin: 3000 });
    rig = updateLight(rig, 'fill', { on: true, intensity: 0.5 });
    rig = updateLight(rig, 'sun', { sunAngleDeg: 42.125, intensity: 19.5 });
    rig = updateLight(rig, 'sky', { intensity: 3.7 });
    rig = updateExposure(rig, 1.25);
    expect(parseRig(serializeRig(rig), DEFAULT_RIG)).toEqual(rig);
  });

  it('keeps the positions, sizes and ring from the base rig rather than the text', () => {
    const parsed = parseRig(serializeRig(DEFAULT_RIG), DEFAULT_RIG);
    expect(light(parsed, 'indirect').members).toEqual(light(DEFAULT_RIG, 'indirect').members);
    expect(light(parsed, 'key').size).toEqual(light(DEFAULT_RIG, 'key').size);
  });

  it('returns the base rig untouched for anything it cannot read', () => {
    for (const text of ['', 'v2;top,1,25,6500', 'nonsense', '{"lights":[]}']) {
      expect(parseRig(text, DEFAULT_RIG)).toBe(DEFAULT_RIG);
    }
  });

  it('takes what it can from a damaged line and leaves the rest at the base value', () => {
    const parsed = parseRig('v1;top,0,40;ghost,1,9,9;key,x,banana,5500;e,', DEFAULT_RIG);
    expect(light(parsed, 'top').on).toBe(false);
    expect(light(parsed, 'top').intensity).toBe(40);
    // The temperature field is missing, so the base value stands.
    expect(light(parsed, 'top').kelvin).toBe(6500);
    // A flag that is neither 0 nor 1 and an intensity that is not a number both fall back.
    expect(light(parsed, 'key').on).toBe(true);
    expect(light(parsed, 'key').intensity).toBe(15);
    expect(light(parsed, 'key').kelvin).toBe(5500);
    expect(parsed.exposure).toBe(1);
  });

  it('clamps a hand edited URL instead of trusting it', () => {
    const parsed = parseRig('v1;top,1,900,90000;sun,1,7,7000,900;e,99', DEFAULT_RIG);
    expect(light(parsed, 'top').intensity).toBe(CANDELA_RANGE[1]);
    expect(light(parsed, 'top').kelvin).toBe(KELVIN_RANGE[1]);
    expect(light(parsed, 'sun').sunAngleDeg).toBe(SUN_ANGLE_RANGE[1]);
    expect(parsed.exposure).toBe(EXPOSURE_RANGE[1]);
  });
});
