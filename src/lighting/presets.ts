// Lighting presets for the studio panel (goals G2.4 step 5, G2.7).
//
// Offers four distinct lighting setups: the level's default rig, outdoor daylight, warm evening,
// and pure studio lights without natural sun. Every value is stored in physical units.

import { DEFAULT_RIG, updateExposure, updateLight } from './rig';
import type { Rig } from './rig';

export type PresetName = 'Level lighting' | 'Daylight' | 'Evening' | 'Studio only';

export const PRESET_ORDER: readonly PresetName[] = [
  'Level lighting',
  'Daylight',
  'Evening',
  'Studio only',
];

function buildDaylight(): Rig {
  let rig = DEFAULT_RIG;
  rig = updateLight(rig, 'sun', { on: true, intensity: 12, sunAngleDeg: 55, kelvin: 6500 });
  rig = updateLight(rig, 'sky', { on: true, intensity: 1.6 });
  rig = updateLight(rig, 'top', { on: false });
  rig = updateLight(rig, 'key', { on: false });
  rig = updateLight(rig, 'fill', { on: false });
  rig = updateLight(rig, 'back', { on: false });
  rig = updateLight(rig, 'indirect', { on: false });
  return updateExposure(rig, 1.0);
}

function buildEvening(): Rig {
  let rig = DEFAULT_RIG;
  rig = updateLight(rig, 'sun', { on: true, intensity: 2, sunAngleDeg: 12, kelvin: 2900 });
  rig = updateLight(rig, 'sky', { on: true, intensity: 0.4 });
  rig = updateLight(rig, 'key', { on: true, intensity: 7.5, kelvin: 4500 });
  rig = updateLight(rig, 'fill', { on: true, intensity: 3.5, kelvin: 7000 });
  rig = updateLight(rig, 'top', { on: false });
  rig = updateLight(rig, 'back', { on: false });
  rig = updateLight(rig, 'indirect', { on: false });
  return updateExposure(rig, 1.0);
}

function buildStudioOnly(): Rig {
  let rig = DEFAULT_RIG;
  rig = updateLight(rig, 'sun', { on: false });
  rig = updateLight(rig, 'sky', { on: true, intensity: 0.2 });
  rig = updateLight(rig, 'top', { on: true, intensity: 25, kelvin: 6500 });
  rig = updateLight(rig, 'key', { on: true, intensity: 15, kelvin: 4500 });
  rig = updateLight(rig, 'fill', { on: true, intensity: 7, kelvin: 7000 });
  rig = updateLight(rig, 'back', { on: true, intensity: 7, kelvin: 6500 });
  rig = updateLight(rig, 'indirect', { on: true, intensity: 5, kelvin: 5000 });
  return updateExposure(rig, 1.0);
}

/** The four rigs the panel offers, DEFAULT_RIG first. Every value in the rig's own units. */
export const LIGHTING_PRESETS: Readonly<Record<PresetName, Rig>> = {
  'Level lighting': DEFAULT_RIG,
  Daylight: buildDaylight(),
  Evening: buildEvening(),
  'Studio only': buildStudioOnly(),
};
