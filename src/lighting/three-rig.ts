// The studio rig as Three.js objects. Imports from 'three', never from 'three/webgpu',
// so the entire module runs in node and the tests can read every light back without a GPU.
//
// One writer: apply(). createThreeRig builds the objects and calls apply once, and every later change
// goes through apply again, so values never drift.
//
// Active runtime rig:
// - Exactly three studio RectAreaLights: Key, Fill, and Back (shadowless).
// - One DirectionalLight: Daylight sun (the only shadow-casting light in the scene).
// - Zero PointLights. TopLight and the 8-point IndirectLight ring are completely removed.

import { DirectionalLight, Group, Object3D, RectAreaLight } from 'three';
import type { Light } from 'three';

import { daylightSun } from './rig';
import type { Rig, RigLight, RigStudioLightId } from './rig';
import { candelaToNits } from './units';

export type RigLightLookupId = RigStudioLightId | 'sun';

export interface ThreeRig {
  /** Add this to the scene. Everything the rig owns hangs off it. */
  group: Group;
  /** Idempotent: sets on/off, intensity, colour and transforms from the rig. */
  apply(rig: Rig): void;
  /** For tests and inspection. Returns lights by id. */
  lightsById: ReadonlyMap<RigLightLookupId, Light[]>;
  dispose(): void;
}

export interface ThreeRigOptions {
  shadowMapSize: number;
  sunShadow: boolean;
}

/** How far up its arc the sun sits. */
const SUN_DISTANCE_M = 20;

/**
 * Half the width of the sun's shadow frustum. 9 m covers the 16 m room at every sun angle.
 */
const SHADOW_HALF_EXTENT_M = 9;
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
  light.color.set(entry.color);
  aim(light, requirePosition(entry), requireDirection(entry));
}

function applySun(light: DirectionalLight, daylight: number, options: ThreeRigOptions): void {
  const params = daylightSun(daylight);
  light.visible = true;
  light.intensity = params.intensity;
  light.color.set(params.color);
  light.position.set(
    -params.direction[0] * SUN_DISTANCE_M,
    -params.direction[1] * SUN_DISTANCE_M,
    -params.direction[2] * SUN_DISTANCE_M,
  );
  light.castShadow = options.sunShadow;
}

export function createThreeRig(rig: Rig, options: ThreeRigOptions): ThreeRig {
  const group = new Group();
  group.name = 'studio-rig';

  const lightsById = new Map<RigLightLookupId, Light[]>();
  const rects = new Map<RigStudioLightId, RectAreaLight>();

  for (const entry of rig.lights) {
    const light = new RectAreaLight();
    light.name = entry.label;
    rects.set(entry.id, light);
    lightsById.set(entry.id, [light]);
    group.add(light);
  }

  // Exactly one DirectionalLight for Daylight sun
  const sun = new DirectionalLight();
  sun.name = 'DaylightSun';
  sun.shadow.mapSize.set(options.shadowMapSize, options.shadowMapSize);
  sun.shadow.camera.left = -SHADOW_HALF_EXTENT_M;
  sun.shadow.camera.right = SHADOW_HALF_EXTENT_M;
  sun.shadow.camera.top = SHADOW_HALF_EXTENT_M;
  sun.shadow.camera.bottom = -SHADOW_HALF_EXTENT_M;
  sun.shadow.camera.near = SHADOW_NEAR_M;
  sun.shadow.camera.far = SHADOW_FAR_M;
  sun.shadow.camera.updateProjectionMatrix();

  const target = new Object3D();
  target.name = 'sun-target';
  sun.target = target;
  group.add(target);
  group.add(sun);
  lightsById.set('sun', [sun]);

  function apply(next: Rig): void {
    for (const entry of next.lights) {
      const light = rects.get(entry.id);
      if (light) applyRect(light, entry);
    }
    applySun(sun, next.daylight, options);
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
