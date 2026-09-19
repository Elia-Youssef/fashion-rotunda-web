// The studio rig as data: seven entries carrying the Unreal level's own values, converted to three.js
// metres and physical units. No three.js import and no DOM, so the whole rig is testable in node and the
// panel can drive it without a renderer.
//
// Source of every number: assets-src/source/unreal/lights.json, written by the level export. That file is
// not in the repository (.gitignore line 11 ignores assets-src/source/unreal/), so the values it carries
// are copied into UNREAL below and the tests state the converted results. Read the file when a value looks
// wrong; do not guess one.
//
// What is deliberately dropped:
// - light_color, 188/225/255 on the rect lights and 255/215/179 on the point lights. Unreal multiplies that
//   fixed tint by the temperature colour; keeping both would tint every light twice, once from a slider the
//   panel shows and once from a constant it does not. The temperature is the control the product needs, so
//   the tint goes and the panel's kelvin is the only colour source.
// - barn doors, source_length, specular_scale, indirect_lighting_intensity and
//   volumetric_scattering_intensity: Unreal features with no three.js equivalent in this goal.
// - cast_shadows on the rect and point lights. three's RectAreaLight has no shadow support at all
//   (src/lights/RectAreaLight.js line 10), and eight shadow casting point lights would be 48 cube faces a
//   frame. One room gets one shadow map, from the sun.

import {
  CANDELA_RANGE,
  KELVIN_RANGE,
  SKY_SCALE_RANGE,
  SUN_ANGLE_RANGE,
  SUN_LUX_RANGE,
  clamp,
  unrealToThreeDirection,
  unrealToThreePosition,
} from './units';

export type RigLightKind = 'rect' | 'point' | 'sun' | 'sky';

export interface RigLight {
  id: 'top' | 'key' | 'fill' | 'back' | 'indirect' | 'sun' | 'sky';
  /** The name the Unreal panel prints, so a screenshot of one reads against the other. */
  label: string;
  kind: RigLightKind;
  on: boolean;
  /** Candela for rect and point, lux for the sun, a unitless scale for the sky. */
  intensity: number;
  kelvin: number;
  /** Metres, three axes. Absent for the sun and the sky. For the point ring this is the ring centre. */
  position?: [number, number, number];
  /** Unit vector the light points along. Rect and sun only. On the sun it derives from sunAngleDeg. */
  direction?: [number, number, number];
  /** Metres, rect only. Full width and height, not half extents: Unreal states source_width that way too. */
  size?: [number, number];
  /** One position per member of the point ring. createThreeRig places the lights from this, not position. */
  members?: [number, number, number][];
  /** Sun only: 0 east, 90 zenith, 180 west, along the arc the Unreal sun already sits on. */
  sunAngleDeg?: number;
  castShadow: boolean;
}

export interface Rig {
  lights: RigLight[];
  /** The renderer's toneMappingExposure. 1 until it is tuned against the stills. */
  exposure: number;
}

/** What a panel control for one kind of light spans, and the unit its readout prints. */
export interface IntensityScale {
  range: readonly [number, number];
  step: number;
  unit: string;
}

/** Metres at which a ring point light stops contributing. Unreal attenuation_radius, 1000 cm. */
export const INDIRECT_DISTANCE_M = 10;

/** A tolerance band for parseRig only, so a hand edited URL cannot black out or blow out the page. */
export const EXPOSURE_RANGE: readonly [number, number] = [0.05, 8];

/** The serialized format's first field. A different value means a rig this build cannot read. */
const RIG_FORMAT = 'v1';

/** The finest step any control offers is the sun angle at 0.001 degrees, so three decimals round trip. */
const SERIALIZED_DECIMALS = 3;

interface UnrealRectLight {
  intensity: number;
  kelvin: number;
  visible: boolean;
  locationCm: [number, number, number];
  forward: [number, number, number];
  sizeCm: [number, number];
}

interface UnrealPointRing {
  intensity: number;
  kelvin: number;
  visible: boolean;
  membersCm: [number, number, number][];
}

interface UnrealSun {
  intensity: number;
  kelvin: number;
  visible: boolean;
  forward: [number, number, number];
}

interface UnrealSky {
  intensity: number;
  visible: boolean;
}

/**
 * The Unreal values, verbatim from lights.json. Locations and sizes are centimetres, intensities are
 * candela except the sun, which Unreal states in lux and writes with no intensity_units field.
 */
const UNREAL: {
  top: UnrealRectLight;
  key: UnrealRectLight;
  fill: UnrealRectLight;
  back: UnrealRectLight;
  indirect: UnrealPointRing;
  sun: UnrealSun;
  sky: UnrealSky;
} = {
  top: {
    intensity: 25,
    kelvin: 6500,
    visible: true,
    locationCm: [0, 0, 600],
    forward: [-2.220446049250313e-16, 0, -1.0000000000000002],
    sizeCm: [400, 400],
  },
  key: {
    intensity: 15,
    kelvin: 4500,
    visible: true,
    locationCm: [200, -200, 280],
    forward: [-0.6459741880212506, 0.645974188021251, -0.40673664307580015],
    sizeCm: [60, 90],
  },
  fill: {
    intensity: 7,
    kelvin: 7000,
    visible: false,
    locationCm: [-215, -230, 280],
    forward: [0.645974188021251, 0.6459741880212508, -0.40673664307580015],
    sizeCm: [150, 150],
  },
  back: {
    intensity: 7,
    kelvin: 6500,
    visible: false,
    locationCm: [5, 330, 300],
    forward: [-4.440892098500626e-16, -0.9135454576426016, -0.4067366430757995],
    sizeCm: [150, 150],
  },
  indirect: {
    intensity: 5,
    kelvin: 5000,
    visible: true,
    // BP_PointLightActor_01 to _08, in that order. The ring is not perfectly circular in the level and is
    // kept as authored: the radii run 7.110, 7.122 and 7.128 metres.
    membersCm: [
      [0, 711, 657],
      [-503.629166, 503.62887, 657],
      [-712.8, 0, 657],
      [-503.629166, -503.62887, 657],
      [0, -711, 657],
      [503.629166, -503.62887, 657],
      [712.8, 0, 657],
      [503.629166, 503.62887, 657],
    ],
  },
  sun: {
    intensity: 7,
    kelvin: 7000,
    visible: true,
    forward: [0.6387413386906354, -0.11617802907643715, -0.7605998736573714],
  },
  sky: {
    intensity: 2,
    visible: true,
  },
};

/**
 * The sun's arc. The Unreal sun points 49.517 degrees below the horizontal (its own pitch), so the sun sits
 * at that elevation on the far side of the sky from where it shines. The arc runs through that same
 * vertical plane: its east end is the horizontal unit vector in the plane whose x is positive, three's +x
 * being east, and the angle sweeps from there through the zenith to the west end.
 */
function deriveSunArc(): { east: [number, number, number]; angleDeg: number } {
  const direction = unrealToThreeDirection(UNREAL.sun.forward);
  // The unit vector from the origin towards the sun is the opposite of the one it shines along.
  const toSun: [number, number, number] = [-direction[0], -direction[1], -direction[2]];
  const horizontal = Math.hypot(toSun[0], toSun[2]);
  // The end of the arc with a positive x is the east one. The Unreal sun's own x is negative, so the arc's
  // east end is the opposite horizontal vector and the sun sits past the zenith, in the west half.
  const sign = toSun[0] < 0 ? -1 : 1;
  // A sun straight overhead has no horizontal part and every arc through it is the same arc, so +x wins.
  const east: [number, number, number] =
    horizontal > 0 ? [(sign * toSun[0]) / horizontal, 0, (sign * toSun[2]) / horizontal] : [1, 0, 0];
  const cosine = toSun[0] * east[0] + toSun[2] * east[2];
  const angleDeg = (Math.atan2(toSun[1], cosine) * 180) / Math.PI;
  return { east, angleDeg: round(angleDeg, SERIALIZED_DECIMALS) };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

const SUN_ARC = deriveSunArc();

/**
 * The direction the sun shines along at a given angle on its arc: 0 east, 90 zenith, 180 west. The rig
 * keeps every sun entry's direction equal to this, so nothing downstream has to know the arc exists.
 */
export function sunDirection(angleDeg: number): [number, number, number] {
  const radians = (clamp(angleDeg, SUN_ANGLE_RANGE[0], SUN_ANGLE_RANGE[1]) * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const toSun: [number, number, number] = [
    cosine * SUN_ARC.east[0],
    Math.sin(radians),
    cosine * SUN_ARC.east[2],
  ];
  return [-toSun[0], -toSun[1], -toSun[2]];
}

/** What a control for this kind of light spans. The panel and parseRig share it so they cannot disagree. */
export function intensityScale(kind: RigLightKind): IntensityScale {
  switch (kind) {
    case 'sun':
      return { range: SUN_LUX_RANGE, step: 0.5, unit: 'lx' };
    case 'sky':
      return { range: SKY_SCALE_RANGE, step: 0.1, unit: 'scale' };
    default:
      return { range: CANDELA_RANGE, step: 0.5, unit: 'cd' };
  }
}

function buildDefaultRig(): Rig {
  const lights: RigLight[] = [
    {
      id: 'top',
      label: 'TopLight',
      kind: 'rect',
      on: UNREAL.top.visible,
      intensity: UNREAL.top.intensity,
      kelvin: UNREAL.top.kelvin,
      position: unrealToThreePosition(UNREAL.top.locationCm),
      direction: unrealToThreeDirection(UNREAL.top.forward),
      size: [UNREAL.top.sizeCm[0] / 100, UNREAL.top.sizeCm[1] / 100],
      castShadow: false,
    },
    {
      id: 'key',
      label: 'KeyLight',
      kind: 'rect',
      on: UNREAL.key.visible,
      intensity: UNREAL.key.intensity,
      kelvin: UNREAL.key.kelvin,
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
      kelvin: UNREAL.fill.kelvin,
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
      kelvin: UNREAL.back.kelvin,
      position: unrealToThreePosition(UNREAL.back.locationCm),
      direction: unrealToThreeDirection(UNREAL.back.forward),
      size: [UNREAL.back.sizeCm[0] / 100, UNREAL.back.sizeCm[1] / 100],
      castShadow: false,
    },
    {
      id: 'indirect',
      label: 'IndirectLight',
      kind: 'point',
      on: UNREAL.indirect.visible,
      intensity: UNREAL.indirect.intensity,
      kelvin: UNREAL.indirect.kelvin,
      // The ring centre, for the panel and the proof overlay. The lights go where members says.
      position: [0, UNREAL.indirect.membersCm[0][2] / 100, 0],
      members: UNREAL.indirect.membersCm.map(unrealToThreePosition),
      castShadow: false,
    },
    {
      id: 'sun',
      label: 'Sun',
      kind: 'sun',
      on: UNREAL.sun.visible,
      intensity: UNREAL.sun.intensity,
      kelvin: UNREAL.sun.kelvin,
      direction: sunDirection(SUN_ARC.angleDeg),
      sunAngleDeg: SUN_ARC.angleDeg,
      castShadow: true,
    },
    {
      id: 'sky',
      label: 'Sky',
      kind: 'sky',
      on: UNREAL.sky.visible,
      intensity: UNREAL.sky.intensity,
      // The Unreal SkyLight carries no temperature. 6500 K is the neutral the panel shows; nothing reads it
      // until the environment gains a tint.
      kelvin: 6500,
      castShadow: false,
    },
  ];
  return freezeRig({ lights, exposure: 1 });
}

/**
 * Frozen so a caller that mutates the default fails loudly instead of poisoning every rig derived from it
 * later. updateLight and parseRig build new objects, so nothing in this module needs to write to one.
 */
function freezeRig(rig: Rig): Rig {
  for (const light of rig.lights) {
    if (light.position) Object.freeze(light.position);
    if (light.direction) Object.freeze(light.direction);
    if (light.size) Object.freeze(light.size);
    if (light.members) {
      for (const member of light.members) Object.freeze(member);
      Object.freeze(light.members);
    }
    Object.freeze(light);
  }
  Object.freeze(rig.lights);
  Object.freeze(rig);
  return rig;
}

/** The rig the page boots with: the Unreal level's own studio, converted. */
export const DEFAULT_RIG: Rig = buildDefaultRig();

/**
 * The sky's contribution for Environment.apply(scene, intensity). An off sky is 0 rather than its stored
 * intensity, so switching it off removes the environment light the same way visible false removes a lamp.
 */
export function skyIntensity(rig: Rig): number {
  const sky = rig.lights.find((light) => light.id === 'sky');
  return sky && sky.on ? sky.intensity : 0;
}

/**
 * One light replaced, everything else shared. Values are clamped to their own ranges, so a rig can never
 * hold a temperature or an intensity the panel could not have produced.
 *
 * On the sun, sunAngleDeg is the source of truth: a patch carrying it recomputes direction, and a patch
 * carrying direction for the sun is ignored, because two ways to orient one light is one too many.
 */
export function updateLight(rig: Rig, id: RigLight['id'], patch: Partial<RigLight>): Rig {
  const lights = rig.lights.map((light) => {
    if (light.id !== id) return light;
    const next: RigLight = { ...light };
    if (patch.on !== undefined) next.on = patch.on;
    if (patch.intensity !== undefined) {
      const scale = intensityScale(light.kind);
      next.intensity = clamp(patch.intensity, scale.range[0], scale.range[1]);
    }
    if (patch.kelvin !== undefined) next.kelvin = clamp(patch.kelvin, KELVIN_RANGE[0], KELVIN_RANGE[1]);
    if (patch.castShadow !== undefined) next.castShadow = patch.castShadow;
    if (patch.position !== undefined) next.position = patch.position;
    if (patch.size !== undefined) next.size = patch.size;
    if (patch.members !== undefined) next.members = patch.members;
    if (light.kind === 'sun') {
      if (patch.sunAngleDeg !== undefined) {
        const angle = clamp(patch.sunAngleDeg, SUN_ANGLE_RANGE[0], SUN_ANGLE_RANGE[1]);
        next.sunAngleDeg = round(angle, SERIALIZED_DECIMALS);
        next.direction = sunDirection(next.sunAngleDeg);
      }
    } else if (patch.direction !== undefined) {
      next.direction = patch.direction;
    }
    return next;
  });
  return { lights, exposure: rig.exposure };
}

/** Exposure replaced, lights shared. Same immutable shape as updateLight. */
export function updateExposure(rig: Rig, exposure: number): Rig {
  return { lights: rig.lights, exposure: clamp(exposure, EXPOSURE_RANGE[0], EXPOSURE_RANGE[1]) };
}

function formatNumber(value: number): string {
  return String(round(value, SERIALIZED_DECIMALS));
}

/**
 * The rig as one URL safe string, for a link that carries a lighting setup. Stable order, the rig's own
 * order: every field is a decimal number or a 0/1 flag, separated by commas inside a light and semicolons
 * between lights, all of which a query string carries unescaped.
 *
 * Only what a control can change is written: on, intensity, kelvin, the sun's angle and the exposure.
 * Positions, sizes and the ring come from the level, and parseRig takes them from the base rig.
 */
export function serializeRig(rig: Rig): string {
  const parts = [RIG_FORMAT];
  for (const light of rig.lights) {
    const on = light.on ? '1' : '0';
    const fields = [light.id, on, formatNumber(light.intensity), formatNumber(light.kelvin)];
    if (light.sunAngleDeg !== undefined) fields.push(formatNumber(light.sunAngleDeg));
    parts.push(fields.join(','));
  }
  parts.push(`e,${formatNumber(rig.exposure)}`);
  return parts.join(';');
}

function readNumber(field: string | undefined, fallback: number): number {
  if (field === undefined || field === '') return fallback;
  const value = Number(field);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The inverse of serializeRig, tolerant of anything: a wrong format tag, a missing light, an unknown id, a
 * short row, a word where a number belongs. Every unreadable field falls back to the base rig's value and
 * every readable one is clamped by updateLight, so no input produces a rig the panel could not show.
 */
export function parseRig(text: string, base: Rig): Rig {
  const parts = text.split(';');
  if (parts[0] !== RIG_FORMAT) return base;
  let rig = base;
  for (const part of parts.slice(1)) {
    const fields = part.split(',');
    const id = fields[0];
    if (id === 'e') {
      rig = updateExposure(rig, readNumber(fields[1], rig.exposure));
      continue;
    }
    const light = rig.lights.find((entry) => entry.id === id);
    if (!light) continue;
    const patch: Partial<RigLight> = {
      on: fields[1] === '1' ? true : fields[1] === '0' ? false : light.on,
      intensity: readNumber(fields[2], light.intensity),
      kelvin: readNumber(fields[3], light.kelvin),
    };
    if (light.sunAngleDeg !== undefined) {
      patch.sunAngleDeg = readNumber(fields[4], light.sunAngleDeg);
    }
    rig = updateLight(rig, light.id, patch);
  }
  return rig;
}
