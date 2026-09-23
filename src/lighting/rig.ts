// The studio rig as data: three studio lights (Key, Fill, Back) carrying the Unreal level's
// own positions and sizes, plus a single coordinated Daylight/Atmosphere control.
// Pure TypeScript, no three.js import and no DOM, so the whole rig is testable in node.
//
// Source of positions and sizes: assets-src/source/unreal/lights.json.
// What is deliberately removed for UI-5:
// - TopLight and the 8-point IndirectLight ring are removed from the active rig.
// - Separate sun angle, elevation, kelvin, exposure, and sky controls are replaced by
//   the single continuous Daylight/Atmosphere control.
// - RectAreaLights use native color inputs (#RRGGBB). By client decision on 2026-09-23 every light
//   defaults to neutral white at 6500 K (#ffffff) so the scene can be tested cleanly. The
//   Unreal-authored values remain in UNREAL, and UNREAL_COLORS computes their colours: Unreal
//   combines each light's Kelvin temperature with the authored sRGB tint (188, 225, 255) by
//   multiplication, giving Key #bcc8bd (4500 K), Fill #b3dbff (7000 K), Back #bce1ff (6500 K).
// - Only the Daylight sun casts shadows; Key, Fill, and Back remain shadowless.

import {
  CANDELA_RANGE,
  clamp,
  kelvinToRgb,
  unrealToThreeDirection,
  unrealToThreePosition,
} from './units';

export type RigStudioLightId = 'key' | 'fill' | 'back';
export type RigLightId = RigStudioLightId;

export interface RigLight {
  id: RigStudioLightId;
  label: string;
  kind: 'rect';
  on: boolean;
  /** Candela for rect lights in [0, 50]. */
  intensity: number;
  /** Normalized lowercase 6-digit hex color string, e.g. '#bce1ff'. */
  color: string;
  /** Metres, three axes [x, y, z]. */
  position?: [number, number, number];
  /** Unit vector the light points along [x, y, z]. */
  direction?: [number, number, number];
  /** Metres [width, height]. */
  size?: [number, number];
  castShadow: false;
}

export interface Rig {
  lights: RigLight[];
  /** Continuous daylight/atmosphere control from 0.0 (Dawn) to 0.5 (Day) to 1.0 (Dusk). */
  daylight: number;
  /** Preserved tone mapping exposure (default 1.0). */
  exposure: number;
}

export interface IntensityScale {
  range: readonly [number, number];
  step: number;
  unit: string;
}

export { CANDELA_RANGE } from './units';
export const DAYLIGHT_RANGE: readonly [number, number] = [0, 1];
export const DAYLIGHT_STEP = 0.01;
export const EXPOSURE_RANGE: readonly [number, number] = [0.05, 8];

const RIG_FORMAT = 'v2';
const SERIALIZED_DECIMALS = 3;

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Standard linear RGB channel to sRGB [0, 1]. */
function linearToSrgb(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
}

/** Standard sRGB channel to linear RGB [0, 1]. */
export function srgbToLinear(c: number): number {
  const clamped = Math.max(0, Math.min(1, c));
  return clamped <= 0.04045 ? clamped / 12.92 : Math.pow((clamped + 0.055) / 1.055, 2.4);
}

/** Converts a linear RGB triple [0, 1] to a lowercase #rrggbb hex string. */
export function linearRgbToHex(linearRgb: [number, number, number]): string {
  const r = Math.round(linearToSrgb(linearRgb[0]) * 255);
  const g = Math.round(linearToSrgb(linearRgb[1]) * 255);
  const b = Math.round(linearToSrgb(linearRgb[2]) * 255);
  const hex = (val: number) => val.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Converts a Kelvin color temperature to an sRGB #rrggbb hex string. */
export function kelvinToHex(kelvin: number): string {
  return linearRgbToHex(kelvinToRgb(kelvin));
}

/** The sRGB gel Unreal authors on every studio rect light: RGB (188, 225, 255). */
const AUTHORED_TINT_SRGB: readonly [number, number, number] = [188, 225, 255];

/** One tint channel, authored 0-255 sRGB, to linear. Non-finite collapses to 0, never NaN out. */
function tintChannelToLinear(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return srgbToLinear(Math.min(1, Math.max(0, value)));
}

/**
 * The effective color of a studio light: Unreal combines the Kelvin temperature with the authored
 * sRGB tint by multiplication, so the two combine once in linear space — kelvinToRgb is already
 * linear and the tint crosses srgbToLinear exactly once — and linearRgbToHex stores the result as
 * sRGB hex. Every channel stays in [0, 1], so no NaN or out-of-range value can reach a light.
 */
export function kelvinTintToHex(
  kelvin: number,
  tint: readonly [number, number, number] = AUTHORED_TINT_SRGB,
): string {
  const kelvinLinear = kelvinToRgb(kelvin);
  const tintLinear: [number, number, number] = [
    tintChannelToLinear(tint[0] / 255),
    tintChannelToLinear(tint[1] / 255),
    tintChannelToLinear(tint[2] / 255),
  ];
  return linearRgbToHex([
    kelvinLinear[0] * tintLinear[0],
    kelvinLinear[1] * tintLinear[1],
    kelvinLinear[2] * tintLinear[2],
  ]);
}

/** Normalizes any valid hex color string into a clean lowercase '#rrggbb' format. */
export function normalizeHexColor(value: string, fallback = '#ffffff'): string {
  if (typeof value !== 'string') return fallback;
  let clean = value.trim().toLowerCase();
  if (clean.startsWith('#')) clean = clean.slice(1);
  if (clean.length === 3) {
    clean = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2];
  }
  if (!/^[0-9a-f]{6}$/.test(clean)) {
    return fallback;
  }
  return `#${clean}`;
}

/** Converts an '#rrggbb' hex string to linear RGB [0, 1] for Three.js. */
export function hexToLinearRgb(hex: string): [number, number, number] {
  const clean = normalizeHexColor(hex).slice(1);
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

/**
 * Unreal values verbatim from assets-src/source/unreal/lights.json. The kelvin and tint entries are
 * the record of the Unreal-authored colours; the web defaults use neutral white 6500 K instead
 * (client decision 2026-09-23).
 */
const UNREAL = {
  key: {
    intensity: 15,
    kelvin: 4500,
    tint: [188, 225, 255] as [number, number, number],
    visible: true,
    locationCm: [200, -200, 280] as [number, number, number],
    forward: [-0.6459741880212506, 0.645974188021251, -0.40673664307580015] as [number, number, number],
    sizeCm: [60, 90] as [number, number],
  },
  fill: {
    intensity: 7,
    kelvin: 7000,
    tint: [188, 225, 255] as [number, number, number],
    visible: false,
    locationCm: [-215, -230, 280] as [number, number, number],
    forward: [0.645974188021251, 0.6459741880212508, -0.40673664307580015] as [number, number, number],
    sizeCm: [150, 150] as [number, number],
  },
  back: {
    intensity: 7,
    kelvin: 6500,
    tint: [188, 225, 255] as [number, number, number],
    visible: false,
    locationCm: [5, 330, 300] as [number, number, number],
    forward: [-4.440892098500626e-16, -0.9135454576426016, -0.4067366430757995] as [number, number, number],
    sizeCm: [150, 150] as [number, number],
  },
  sun: {
    intensity: 7,
    kelvin: 7000,
    visible: true,
    forward: [0.6387413386906354, -0.11617802907643715, -0.7605998736573714] as [number, number, number],
  },
};

/**
 * The Unreal-authored light colours, computed from UNREAL: each studio light is its Kelvin
 * temperature times its authored tint, the sun is its Kelvin temperature alone. A read-only record
 * for restoring or comparing; the web defaults do not use it (neutral white 6500 K, client decision
 * 2026-09-23).
 */
export const UNREAL_COLORS: Readonly<Record<RigStudioLightId | 'sun', string>> = Object.freeze({
  key: kelvinTintToHex(UNREAL.key.kelvin, UNREAL.key.tint),
  fill: kelvinTintToHex(UNREAL.fill.kelvin, UNREAL.fill.tint),
  back: kelvinTintToHex(UNREAL.back.kelvin, UNREAL.back.tint),
  sun: kelvinToHex(UNREAL.sun.kelvin),
});

/**
 * The sun's arc across the Rotunda.
 * East end: unit vector in vertical plane with +x. Sweeps through zenith (90 deg) to west.
 */
function deriveSunArc(): { east: [number, number, number]; angleDeg: number } {
  const direction = unrealToThreeDirection(UNREAL.sun.forward);
  const toSun: [number, number, number] = [-direction[0], -direction[1], -direction[2]];
  const horizontal = Math.hypot(toSun[0], toSun[2]);
  const sign = toSun[0] < 0 ? -1 : 1;
  const east: [number, number, number] =
    horizontal > 0 ? [(sign * toSun[0]) / horizontal, 0, (sign * toSun[2]) / horizontal] : [1, 0, 0];
  const cosine = toSun[0] * east[0] + toSun[2] * east[2];
  const angleDeg = (Math.atan2(toSun[1], cosine) * 180) / Math.PI;
  return { east, angleDeg: round(angleDeg, SERIALIZED_DECIMALS) };
}

const SUN_ARC = deriveSunArc();

/**
 * Returns the direction vector the sun shines along for a given angle on its arc (0 east, 90 zenith, 180 west).
 */
export function sunDirection(angleDeg: number): [number, number, number] {
  const radians = (clamp(angleDeg, 0, 180) * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const toSun: [number, number, number] = [
    cosine * SUN_ARC.east[0],
    Math.sin(radians),
    cosine * SUN_ARC.east[2],
  ];
  return [-toSun[0], -toSun[1], -toSun[2]];
}

export interface DaylightParameters {
  /** Sun angle in degrees along arc: 130.4829 (Unreal reference). */
  angleDeg: number;
  /** Sun direction vector [x, y, z] pointing along sunlight path. */
  direction: [number, number, number];
  /** Sun intensity in lux. */
  intensity: number;
  /** Correlated color temperature in Kelvin. */
  kelvin: number;
  /** Normalized #rrggbb hex color tint. */
  color: string;
  /** Environment/sky intensity factor for scene.environmentIntensity. */
  skyIntensity: number;
  /** Background intensity factor for scene.backgroundIntensity. */
  backgroundIntensity: number;
  /** Coordinated renderer tone mapping exposure. */
  exposure: number;
}

/**
 * Evaluates the coordinated daylight parameters from the single continuous daylight input:
 * 0.0: Minimum Daylight (navigable, warm 4000 K sun, gentle ambient, conservative exposure)
 * 0.5: Reference Daylight (Unreal reference 7.0 lux, sky 2.0, exposure 1.0; neutral white 6500 K #ffffff
 *      by client decision on 2026-09-23, where Unreal authors 7000 K #f3f8ff, UNREAL_COLORS.sun)
 * 1.0: Maximum Daylight (bright 12.0 lux, crisp 7500 K, sky 2.6, stopped-down exposure to prevent clipping)
 */
export function daylightParameters(daylight: number): DaylightParameters {
  const safeDaylight = typeof daylight === 'number' && !Number.isNaN(daylight) ? daylight : 0.5;
  const d = clamp(safeDaylight, DAYLIGHT_RANGE[0], DAYLIGHT_RANGE[1]);

  // Sun direction matches the established web conversion of the Unreal directional light
  const angleDeg = SUN_ARC.angleDeg;
  const direction = unrealToThreeDirection(UNREAL.sun.forward);

  // Directional sun intensity increases smoothly: 2.0 at d=0, 7.0 at d=0.5 (Unreal reference), 12.0 at d=1
  const intensity = round(2.0 + 10.0 * d, SERIALIZED_DECIMALS);

  // Color temperature: warm low daylight (4000 K) -> neutral white (6500 K, client decision
  // 2026-09-23; Unreal authors 7000 K) -> crisp (7500 K)
  const kelvin = Math.round(
    d <= 0.5
      ? 4000 + (6500 - 4000) * (d / 0.5)
      : 6500 + (7500 - 6500) * ((d - 0.5) / 0.5),
  );
  const color = kelvinToHex(kelvin);

  // Environment/sky intensity: concave quadratic curve 1.0 -> 2.0 (Unreal SkyLight 2) -> 2.6
  const sky = round(-0.8 * d * d + 2.4 * d + 1.0, SERIALIZED_DECIMALS);

  // Background intensity: visually related to environment without blowing out cloud detail
  const background = round(-0.10 * d * d + 0.25 * d + 0.15, SERIALIZED_DECIMALS);

  // Coordinated exposure: conservative tone-mapping exposure preventing highlight clipping at high daylight
  const exposure = round(1.10 - 0.20 * d, SERIALIZED_DECIMALS);

  return {
    angleDeg,
    direction,
    intensity,
    kelvin,
    color,
    skyIntensity: sky,
    backgroundIntensity: background,
    exposure,
  };
}

/** Evaluates the active directional sun parameters for the runtime rig. */
export function daylightSun(daylight: number): DaylightParameters {
  return daylightParameters(daylight);
}

/** Evaluates the sky environment intensity for a given rig. */
export function skyIntensity(rig: Rig): number {
  return daylightParameters(rig.daylight).skyIntensity;
}

export function intensityScale(kind: 'rect' = 'rect'): IntensityScale {
  void kind;
  return { range: CANDELA_RANGE, step: 0.5, unit: 'cd' };
}

function freezeRig(rig: Rig): Rig {
  for (const light of rig.lights) {
    if (light.position) Object.freeze(light.position);
    if (light.direction) Object.freeze(light.direction);
    if (light.size) Object.freeze(light.size);
    Object.freeze(light);
  }
  Object.freeze(rig.lights);
  Object.freeze(rig);
  return rig;
}

/**
 * Default studio light colour: neutral white, 6500 K with a white tint, by client decision on
 * 2026-09-23. The Unreal-authored colours are in UNREAL_COLORS; the tests pin them.
 */
const STUDIO_DEFAULT_COLOR = '#ffffff';

function buildDefaultRig(): Rig {
  const lights: RigLight[] = [
    {
      id: 'key',
      label: 'KeyLight',
      kind: 'rect',
      on: UNREAL.key.visible,
      intensity: UNREAL.key.intensity,
      color: STUDIO_DEFAULT_COLOR, // Unreal: UNREAL_COLORS.key, #bcc8bd
      position: unrealToThreePosition(UNREAL.key.locationCm),
      direction: unrealToThreeDirection(UNREAL.key.forward),
      size: [UNREAL.key.sizeCm[0] / 100, UNREAL.key.sizeCm[1] / 100],
      castShadow: false,
    },
    {
      id: 'fill',
      label: 'FillLight',
      kind: 'rect',
      on: UNREAL.fill.visible,
      intensity: UNREAL.fill.intensity,
      color: STUDIO_DEFAULT_COLOR, // Unreal: UNREAL_COLORS.fill, #b3dbff
      position: unrealToThreePosition(UNREAL.fill.locationCm),
      direction: unrealToThreeDirection(UNREAL.fill.forward),
      size: [UNREAL.fill.sizeCm[0] / 100, UNREAL.fill.sizeCm[1] / 100],
      castShadow: false,
    },
    {
      id: 'back',
      label: 'BackLight',
      kind: 'rect',
      on: UNREAL.back.visible,
      intensity: UNREAL.back.intensity,
      color: STUDIO_DEFAULT_COLOR, // Unreal: UNREAL_COLORS.back, #bce1ff
      position: unrealToThreePosition(UNREAL.back.locationCm),
      direction: unrealToThreeDirection(UNREAL.back.forward),
      size: [UNREAL.back.sizeCm[0] / 100, UNREAL.back.sizeCm[1] / 100],
      castShadow: false,
    },
  ];

  return freezeRig({
    lights,
    daylight: 0.5, // Neutral Day
    exposure: 1,
  });
}

export const DEFAULT_RIG: Rig = buildDefaultRig();

/**
 * Immutable update of a studio light in the rig.
 */
export function updateLight(rig: Rig, id: RigStudioLightId, patch: Partial<RigLight>): Rig {
  const lights = rig.lights.map((light) => {
    if (light.id !== id) return light;
    const next: RigLight = { ...light };
    if (patch.on !== undefined) next.on = patch.on;
    if (patch.intensity !== undefined) {
      next.intensity = clamp(patch.intensity, CANDELA_RANGE[0], CANDELA_RANGE[1]);
    }
    if (patch.color !== undefined) {
      next.color = normalizeHexColor(patch.color, light.color);
    }
    if (patch.position !== undefined) next.position = patch.position;
    if (patch.size !== undefined) next.size = patch.size;
    if (patch.direction !== undefined) next.direction = patch.direction;
    return next;
  });
  return { lights, daylight: rig.daylight, exposure: rig.exposure };
}

/**
 * Immutable update of the continuous daylight setting.
 * Deterministically updates coordinated exposure from daylightParameters.
 */
export function updateDaylight(rig: Rig, daylight: number): Rig {
  const safeDaylight = typeof daylight === 'number' && !Number.isNaN(daylight) ? daylight : 0.5;
  const clampedDaylight = clamp(safeDaylight, DAYLIGHT_RANGE[0], DAYLIGHT_RANGE[1]);
  const params = daylightParameters(clampedDaylight);
  return {
    lights: rig.lights,
    daylight: clampedDaylight,
    exposure: params.exposure,
  };
}

/** Exposure replaced, lights and daylight shared. */
export function updateExposure(rig: Rig, exposure: number): Rig {
  const safeExposure = typeof exposure === 'number' && Number.isFinite(exposure) ? exposure : 1.0;
  return {
    lights: rig.lights,
    daylight: rig.daylight,
    exposure: clamp(safeExposure, EXPOSURE_RANGE[0], EXPOSURE_RANGE[1]),
  };
}

function formatNumber(value: number): string {
  return String(round(value, SERIALIZED_DECIMALS));
}

/**
 * Serializes the rig into a compact URL-safe string (v2).
 * Hex colors are written without leading '#' so no percent-encoding is required in URLs.
 * Exposure is omitted when equal to default (DEFAULT_RIG.exposure = 1) to keep links byte-identical.
 * Example (the default rig): v2;key,1,15,ffffff;fill,0,7,ffffff;back,0,7,ffffff;day,0.5
 */
export function serializeRig(rig: Rig): string {
  const parts = [RIG_FORMAT];
  for (const light of rig.lights) {
    const on = light.on ? '1' : '0';
    const hex = light.color.replace(/^#/, '').toLowerCase();
    parts.push([light.id, on, formatNumber(light.intensity), hex].join(','));
  }
  parts.push(`day,${formatNumber(rig.daylight)}`);
  if (round(rig.exposure, SERIALIZED_DECIMALS) !== round(DEFAULT_RIG.exposure, SERIALIZED_DECIMALS)) {
    parts.push(`e,${formatNumber(rig.exposure)}`);
  }
  return parts.join(';');
}

function readNumber(field: string | undefined, fallback: number): number {
  if (field === undefined || field === '') return fallback;
  const value = Number(field);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Tolerant parser supporting current v2 format and explicit migration from legacy v1 strings.
 * Never throws on malformed input. Removed Top and Indirect lights are completely ignored
 * and NEVER reinterpreted as another light.
 */
export function parseRig(text: string, base: Rig = DEFAULT_RIG): Rig {
  if (typeof text !== 'string' || text.length === 0) return base;
  const parts = text.split(';');
  const version = parts[0];

  if (version === 'v2') {
    let rig = base;
    for (const part of parts.slice(1)) {
      const fields = part.split(',');
      const id = fields[0];
      if (id === 'day') {
        rig = updateDaylight(rig, readNumber(fields[1], rig.daylight));
        continue;
      }
      if (id === 'e') {
        rig = updateExposure(rig, readNumber(fields[1], rig.exposure));
        continue;
      }
      if (id === 'key' || id === 'fill' || id === 'back') {
        const patch: Partial<RigLight> = {};
        if (fields[1] === '1') patch.on = true;
        else if (fields[1] === '0') patch.on = false;
        if (fields[2] !== undefined) patch.intensity = readNumber(fields[2], 0);
        if (fields[3] !== undefined && fields[3].length > 0) {
          patch.color = normalizeHexColor(fields[3]);
        }
        rig = updateLight(rig, id, patch);
      }
    }
    return rig;
  }

  // Explicit backward-compatible migration from v1 format
  if (version === 'v1') {
    let rig = base;
    for (const part of parts.slice(1)) {
      const fields = part.split(',');
      const id = fields[0];

      // Explicitly ignore removed lights: TopLight, IndirectLight, exposure
      if (id === 'top' || id === 'indirect' || id === 'e') {
        continue;
      }

      if (id === 'key' || id === 'fill' || id === 'back') {
        const patch: Partial<RigLight> = {};
        if (fields[1] === '1') patch.on = true;
        else if (fields[1] === '0') patch.on = false;
        if (fields[2] !== undefined) patch.intensity = readNumber(fields[2], 0);
        // In v1, fields[3] was Kelvin color temperature
        if (fields[3] !== undefined && fields[3].length > 0) {
          const kelvin = readNumber(fields[3], 6500);
          patch.color = kelvinToHex(kelvin);
        }
        rig = updateLight(rig, id, patch);
        continue;
      }

      if (id === 'sun') {
        // In v1, sun had sunAngleDeg at fields[4]
        if (fields[4] !== undefined && fields[4].length > 0) {
          const angle = readNumber(fields[4], 90);
          // Map angle [15, 165] back to daylight [0, 1]
          const mappedDaylight = clamp((angle - 15) / 150, 0, 1);
          rig = updateDaylight(rig, round(mappedDaylight, SERIALIZED_DECIMALS));
        }
      }
    }
    return rig;
  }

  // Unknown format tag falls back safely to base
  return base;
}
