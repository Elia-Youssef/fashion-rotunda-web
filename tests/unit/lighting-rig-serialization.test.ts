import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RIG,
  parseRig,
  serializeRig,
  updateDaylight,
  updateExposure,
  updateLight,
} from '../../src/lighting/rig';
import { studioLight } from '../support/lighting-rig';
import type { Rig } from '../../src/lighting/rig';

// The link serialization: the v2 format and its precision rules, the v1 migration, and
// what parseRig tolerates on malformed fields.

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

describe('Serialization precision and link bytes', () => {
  it('rounds every serialized number to 3 decimals', () => {
    const rig = updateLight(DEFAULT_RIG, 'key', { intensity: 22.3456 });
    expect(serializeRig(rig)).toContain('key,1,22.346,ffffff');
  });

  it('writes lowercase hex even when the rig carries an uppercase color', () => {
    const shouting: Rig = {
      ...DEFAULT_RIG,
      lights: DEFAULT_RIG.lights.map((light) =>
        light.id === 'key' ? { ...light, color: '#AABBCC' } : light,
      ),
    };
    expect(serializeRig(shouting)).toContain('key,1,15,aabbcc');
    expect(serializeRig(shouting)).not.toContain('AABBCC');
  });

  it('omits the exposure part when it rounds to the default at link precision', () => {
    const nudged = updateExposure(DEFAULT_RIG, 1.0004);
    expect(nudged.exposure).toBe(1.0004);
    expect(serializeRig(nudged)).not.toContain(';e,');
  });
});

describe('parseRig tolerance on malformed fields', () => {
  it('returns the base for non-string input instead of throwing', () => {
    expect(parseRig(undefined as unknown as string, DEFAULT_RIG)).toBe(DEFAULT_RIG);
    expect(parseRig(42 as unknown as string, DEFAULT_RIG)).toBe(DEFAULT_RIG);
  });

  it('an empty day field keeps the current daylight instead of becoming 0', () => {
    expect(parseRig('v2;day,', DEFAULT_RIG).daylight).toBe(0.5);
  });

  it('a non-numeric day field keeps the base daylight instead of resetting to 0.5', () => {
    const moved = updateDaylight(DEFAULT_RIG, 0.8);
    expect(parseRig('v2;day,abc', moved).daylight).toBe(0.8);
  });

  it('an unrecognized on flag leaves the on state of the light unchanged (v2 and v1)', () => {
    const fillOn = updateLight(DEFAULT_RIG, 'fill', { on: true });
    expect(studioLight(parseRig('v2;fill,x,7,ffffff', fillOn), 'fill').on).toBe(true);
    const backOn = updateLight(DEFAULT_RIG, 'back', { on: true });
    expect(studioLight(parseRig('v1;back,x,7,6500', backOn), 'back').on).toBe(true);
  });

  it('an empty color field keeps the current color of the light (v2 and v1)', () => {
    const tinted = updateLight(DEFAULT_RIG, 'key', { color: '#123456' });
    expect(studioLight(parseRig('v2;key,1,15,', tinted), 'key').color).toBe('#123456');
    expect(studioLight(parseRig('v1;key,1,15,', tinted), 'key').color).toBe('#123456');
  });

  it('an invalid v1 kelvin field falls back to 6500 K white', () => {
    const tinted = updateLight(DEFAULT_RIG, 'key', { color: '#123456' });
    expect(studioLight(parseRig('v1;key,1,15,abc', tinted), 'key').color).toBe('#ffffff');
  });

  it('v1 sun angle: an empty field keeps the daylight, an invalid one falls back to 90 deg', () => {
    const moved = updateDaylight(DEFAULT_RIG, 0.2);
    expect(parseRig('v1;sun,1,7,7000,', moved).daylight).toBe(0.2);
    expect(parseRig('v1;sun,1,7,7000,abc', moved).daylight).toBe(0.5);
  });

  it('an unknown version tag returns the caller base rig, not the default', () => {
    const moved = updateDaylight(DEFAULT_RIG, 0.75);
    expect(parseRig('v9;key,1,15,ffffff', moved)).toBe(moved);
  });
});
