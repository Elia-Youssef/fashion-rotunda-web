// Unit tests for studio lighting presets (goals G2.4 step 5, G2.7).

import { describe, expect, it } from 'vitest';

import { LIGHTING_PRESETS, PRESET_ORDER } from '../../src/lighting/presets';
import type { PresetName } from '../../src/lighting/presets';
import { DEFAULT_RIG, EXPOSURE_RANGE, serializeRig } from '../../src/lighting/rig';
import {
  CANDELA_RANGE,
  KELVIN_RANGE,
  SKY_SCALE_RANGE,
  SUN_ANGLE_RANGE,
  SUN_LUX_RANGE,
} from '../../src/lighting/units';

describe('lighting presets', () => {
  it('defines exactly four presets with DEFAULT_RIG first in PRESET_ORDER', () => {
    expect(PRESET_ORDER).toHaveLength(4);
    expect(PRESET_ORDER[0]).toBe('Level lighting');
    expect(PRESET_ORDER).toEqual(['Level lighting', 'Daylight', 'Evening', 'Studio only']);

    const presetKeys = Object.keys(LIGHTING_PRESETS) as PresetName[];
    expect(presetKeys).toHaveLength(4);
    expect(LIGHTING_PRESETS['Level lighting']).toBe(DEFAULT_RIG);
  });

  it('every light and exposure value is within the exported ranges of units.ts', () => {
    for (const name of PRESET_ORDER) {
      const rig = LIGHTING_PRESETS[name];
      expect(rig.exposure, `${name} exposure`).toBeGreaterThanOrEqual(EXPOSURE_RANGE[0]);
      expect(rig.exposure, `${name} exposure`).toBeLessThanOrEqual(EXPOSURE_RANGE[1]);

      for (const light of rig.lights) {
        expect(light.kelvin, `${name} ${light.id} kelvin`).toBeGreaterThanOrEqual(KELVIN_RANGE[0]);
        expect(light.kelvin, `${name} ${light.id} kelvin`).toBeLessThanOrEqual(KELVIN_RANGE[1]);

        if (light.kind === 'sun') {
          expect(light.intensity, `${name} sun lux`).toBeGreaterThanOrEqual(SUN_LUX_RANGE[0]);
          expect(light.intensity, `${name} sun lux`).toBeLessThanOrEqual(SUN_LUX_RANGE[1]);
          if (light.sunAngleDeg !== undefined) {
            expect(light.sunAngleDeg, `${name} sun angle`).toBeGreaterThanOrEqual(SUN_ANGLE_RANGE[0]);
            expect(light.sunAngleDeg, `${name} sun angle`).toBeLessThanOrEqual(SUN_ANGLE_RANGE[1]);
          }
        } else if (light.kind === 'sky') {
          expect(light.intensity, `${name} sky scale`).toBeGreaterThanOrEqual(SKY_SCALE_RANGE[0]);
          expect(light.intensity, `${name} sky scale`).toBeLessThanOrEqual(SKY_SCALE_RANGE[1]);
        } else {
          expect(light.intensity, `${name} ${light.id} candela`).toBeGreaterThanOrEqual(CANDELA_RANGE[0]);
          expect(light.intensity, `${name} ${light.id} candela`).toBeLessThanOrEqual(CANDELA_RANGE[1]);
        }
      }
    }
  });

  it('every preset serializes to a distinct string', () => {
    const serialized = new Set<string>();
    for (const name of PRESET_ORDER) {
      const text = serializeRig(LIGHTING_PRESETS[name]);
      expect(serialized.has(text), `preset "${name}" serialized form must be unique`).toBe(false);
      serialized.add(text);
    }
    expect(serialized.size).toBe(4);
  });
});
