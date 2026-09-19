// The rig as three.js objects. Imports from 'three', never from 'three/webgpu', so the whole module runs in
// node and the tests can read every light back without a GPU.
//
// One writer: apply(). createThreeRig builds the objects and calls apply once, and every later change goes
// through apply again, so a value can never be set in two places and drift.
//
// Units on the way in, each read in the installed three.js 0.186.0 sources and cited in units.ts:
// - rect: candela to nits through candelaToNits, because three states RectAreaLight.intensity as luminance.
// - point: candela straight through (src/lights/PointLight.js line 25), decay left at its physical 2.
// - sun: lux straight through.
//
// Shadows: only the sun. three's RectAreaLight ignores castShadow entirely (src/lights/RectAreaLight.js
// line 10 says so in as many words), and the point ring is eight lights, which would be 48 cube faces.
//
// Before the first frame the composition root must call registerRectAreaLights() from ./rect-area-ltc,
// which cannot live here because it imports 'three/webgpu'. Without it the four rect lights throw a
// TypeError the moment the renderer builds their shader. That module's header carries the evidence.

import { DirectionalLight, Group, LinearSRGBColorSpace, Object3D, PointLight, RectAreaLight } from 'three';
import type { Light } from 'three';

import { INDIRECT_DISTANCE_M } from './rig';
import type { Rig, RigLight } from './rig';
import { candelaToNits, kelvinToRgb } from './units';

export interface ThreeRig {
  /** Add this to the scene. Everything the rig owns hangs off it. */
  group: Group;
  /** Idempotent: sets on/off, intensity, colour and transforms from the rig, and nothing else. */
  apply(rig: Rig): void;
  /** For tests and the proof overlay. The sky maps to an empty array: it has no three object. */
  lightsById: ReadonlyMap<RigLight['id'], Light[]>;
  dispose(): void;
}

export interface ThreeRigOptions {
  shadowMapSize: number;
  sunShadow: boolean;
}

/** How far up its arc the sun sits. Far enough to read as a sun, near enough to keep the shadow map tight. */
const SUN_DISTANCE_M = 20;

/**
 * Half the width of the sun's shadow frustum. The room is 16 m across and about 8 m tall, and the widest
 * its projection gets on a plane square to the light is sqrt(16^2 + 8^2) = 17.9 m, at an elevation of
 * atan(8/16) = 26.6 degrees. Half of that is 8.94, so 9 m covers the room at every sun angle.
 */
const SHADOW_HALF_EXTENT_M = 9;

/** The sun sits 20 m out, the room reaches 9 m past the origin, so the slab spans both with room to spare. */
const SHADOW_NEAR_M = 1;
const SHADOW_FAR_M = SUN_DISTANCE_M + SHADOW_HALF_EXTENT_M * 2;

function requirePosition(entry: RigLight): [number, number, number] {
  if (!entry.position) throw new TypeError(`rig light ${entry.id} needs a position`);
  return entry.position;
}

function requireDirection(entry: RigLight): [number, number, number] {
  if (!entry.direction) throw new TypeError(`rig light ${entry.id} needs a direction`);
  return entry.direction;
}

function requireSize(entry: RigLight): [number, number] {
  if (!entry.size) throw new TypeError(`rig light ${entry.id} needs a size`);
  return entry.size;
}

function requireMembers(entry: RigLight): [number, number, number][] {
  if (!entry.members) throw new TypeError(`rig light ${entry.id} needs members`);
  return entry.members;
}

/**
 * The temperature tint. LinearSRGBColorSpace is named rather than left to default so the call says which
 * space the numbers are in; it is the renderer's working space (src/math/Color.js line 227 takes the space
 * as its fourth argument and converts from it), so the conversion is the identity today and stays correct
 * if the working space ever changes.
 */
function setKelvin(light: Light, kelvin: number): void {
  const rgb = kelvinToRgb(kelvin);
  light.color.setRGB(rgb[0], rgb[1], rgb[2], LinearSRGBColorSpace);
}

/** Point the light along a direction: look at a target one metre further along it. */
function aim(light: Light, position: [number, number, number], direction: [number, number, number]): void {
  light.position.set(position[0], position[1], position[2]);
  light.lookAt(position[0] + direction[0], position[1] + direction[1], position[2] + direction[2]);
}

function applyRect(light: RectAreaLight, entry: RigLight): void {
  const size = requireSize(entry);
  light.visible = entry.on;
  light.width = size[0];
  light.height = size[1];
  light.intensity = candelaToNits(entry.intensity, size[0], size[1]);
  setKelvin(light, entry.kelvin);
  aim(light, requirePosition(entry), requireDirection(entry));
}

function applyPoints(lights: PointLight[], entry: RigLight): void {
  const members = requireMembers(entry);
  const rgb = kelvinToRgb(entry.kelvin);
  for (let index = 0; index < lights.length; index += 1) {
    const light = lights[index];
    const member = members[index];
    // A rig with fewer members than this ThreeRig was built for hides the extras rather than moving them
    // somewhere arbitrary. createThreeRig sizes the ring, so this only bites a hand written rig.
    light.visible = entry.on && member !== undefined;
    light.intensity = entry.intensity;
    light.color.setRGB(rgb[0], rgb[1], rgb[2], LinearSRGBColorSpace);
    if (member) light.position.set(member[0], member[1], member[2]);
  }
}

function applySun(light: DirectionalLight, entry: RigLight, options: ThreeRigOptions): void {
  const direction = requireDirection(entry);
  light.visible = entry.on;
  light.intensity = entry.intensity;
  setKelvin(light, entry.kelvin);
  // The sun shines along direction, so it sits the other way along it, looking back at the origin.
  light.position.set(
    -direction[0] * SUN_DISTANCE_M,
    -direction[1] * SUN_DISTANCE_M,
    -direction[2] * SUN_DISTANCE_M,
  );
  light.castShadow = options.sunShadow && entry.castShadow;
}

export function createThreeRig(rig: Rig, options: ThreeRigOptions): ThreeRig {
  const group = new Group();
  group.name = 'studio-rig';

  const lightsById = new Map<RigLight['id'], Light[]>();
  const rects = new Map<RigLight['id'], RectAreaLight>();
  const rings = new Map<RigLight['id'], PointLight[]>();
  let sun: DirectionalLight | null = null;

  for (const entry of rig.lights) {
    switch (entry.kind) {
      case 'rect': {
        const light = new RectAreaLight();
        light.name = entry.label;
        rects.set(entry.id, light);
        lightsById.set(entry.id, [light]);
        group.add(light);
        break;
      }
      case 'point': {
        const members = requireMembers(entry);
        const ring = members.map(() => {
          const light = new PointLight();
          light.name = entry.label;
          // distance is the Unreal attenuation radius in metres; decay stays 2, the inverse square law.
          light.distance = INDIRECT_DISTANCE_M;
          light.decay = 2;
          group.add(light);
          return light;
        });
        rings.set(entry.id, ring);
        lightsById.set(entry.id, ring);
        break;
      }
      case 'sun': {
        const light = new DirectionalLight();
        light.name = entry.label;
        light.shadow.mapSize.set(options.shadowMapSize, options.shadowMapSize);
        light.shadow.camera.left = -SHADOW_HALF_EXTENT_M;
        light.shadow.camera.right = SHADOW_HALF_EXTENT_M;
        light.shadow.camera.top = SHADOW_HALF_EXTENT_M;
        light.shadow.camera.bottom = -SHADOW_HALF_EXTENT_M;
        light.shadow.camera.near = SHADOW_NEAR_M;
        light.shadow.camera.far = SHADOW_FAR_M;
        light.shadow.camera.updateProjectionMatrix();
        // The target rides in the group so it has a world matrix wherever the group is added. It never
        // moves: the sun always looks at the room's origin.
        const target = new Object3D();
        target.name = 'sun-target';
        light.target = target;
        group.add(target);
        group.add(light);
        sun = light;
        lightsById.set(entry.id, [light]);
        break;
      }
      case 'sky':
        // No three object. The sky is the environment, which main.ts applies with skyIntensity().
        lightsById.set(entry.id, []);
        break;
    }
  }

  function apply(next: Rig): void {
    for (const entry of next.lights) {
      switch (entry.kind) {
        case 'rect': {
          const light = rects.get(entry.id);
          if (light) applyRect(light, entry);
          break;
        }
        case 'point': {
          const ring = rings.get(entry.id);
          if (ring) applyPoints(ring, entry);
          break;
        }
        case 'sun': {
          if (sun) applySun(sun, entry, options);
          break;
        }
        case 'sky':
          break;
      }
    }
  }

  apply(rig);

  return {
    group,
    apply,
    lightsById,
    dispose(): void {
      for (const lights of lightsById.values()) {
        for (const light of lights) light.dispose();
      }
      group.clear();
    },
  };
}
