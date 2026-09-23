// The lighting composition: stands the studio rig, the environment and the panel up around a
// scene, and one dispose takes them down. Glue over the rest of src/lighting, nothing more.

import type { Scene } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

import { mountLightPanel } from '../ui/lightpanel';
import type { LightPanelHandle } from '../ui/lightpanel';
import { createHdrEnvironment, createProceduralEnvironment, createRoomEnvironment } from './environment';
import type { Environment } from './environment';
import { registerRectAreaLights } from './rect-area-ltc';
import { skySourceFromParam } from './sky';
import { DEFAULT_RIG, daylightParameters, parseRig, serializeRig } from './rig';
import type { Rig } from './rig';
import { createThreeRig } from './three-rig';
import type { ThreeRig } from './three-rig';

export interface LightingOptions {
  renderer: WebGPURenderer;
  scene: Scene;
  /** Where the panel mounts; null mounts no panel, the rig still lights the scene. */
  panelRoot: HTMLElement | null;
  /** From the tier table: the sun's shadow map edge in pixels. */
  shadowMapSize: number;
  sunShadow: boolean;
  /** The School Field Radiance HDR, fetched only when `sky` selects the ?sky=hdr diagnostic. */
  environmentUrl?: string;
  /** The raw ?sky= value; only 'hdr' (with environmentUrl) replaces the default procedural sky. */
  sky?: string | null;
  /** A serialized rig (serializeRig) to boot with, for example from the URL; absent means the level's. */
  initial?: string;
  /** Called after every change so the on-demand loop draws a frame. */
  onChange: () => void;
}

export interface Lighting {
  readonly rig: Rig;
  /** Applies a whole rig: lights, environment strength, exposure, then the panel and onChange. */
  apply(rig: Rig): void;
  serialize(): string;
  dispose(): void;
}

function isTransparent(material: unknown): boolean {
  if (typeof material !== 'object' || material === null) {
    return false;
  }
  if ('transparent' in material && material.transparent === true) {
    return true;
  }
  if ('transmission' in material && typeof material.transmission === 'number' && material.transmission > 0) {
    return true;
  }
  return false;
}

/**
 * Meshes cast and receive the sun's shadow only when told to; the loaded GLBs arrive with both off.
 * Transparent materials, the dome glass above all, receive but never cast: a shadow map has no alpha,
 * so a casting pane would black out the sun that the room is built to let in.
 */
export function enableShadows(root: { traverse(callback: (object: unknown) => void): void }): void {
  root.traverse((object) => {
    if (typeof object === 'object' && object !== null && 'isMesh' in object && object.isMesh === true) {
      const mesh = object;
      if ('castShadow' in mesh && 'receiveShadow' in mesh && 'material' in mesh) {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mesh.castShadow = !materials.some(isTransparent);
        mesh.receiveShadow = true;
      }
    }
  });
}

/**
 * Unreal's sky light scale of 2 sits under a physical sky; three's prefiltered room at the same number
 * floods the marble. These factors map the panel's sky value to scene.environmentIntensity: the room
 * keeps its original fallback tuning and the real outdoor HDR uses the reviewed lower contribution.
 */
export const ROOM_ENVIRONMENT_SCALE = 0.35;
/** A real outdoor HDR carries broader fill than the old synthetic room, so keep its contribution lower. */
export const HDR_ENVIRONMENT_SCALE = 0.2;
/**
 * The procedural lighting sky is authored at zenith luminance 1. The reference is the upright HDR at
 * HDR_ENVIRONMENT_SCALE (the Goal 5 state) as the renderer receives it: HDRLoader clamps every channel
 * to the float16 maximum 65504, which cuts the file's baked sun disc to about a third. 0.927 is the
 * geometric mean of the scale matching its cosine up irradiance and the scale matching a narrow-lobe
 * stand-in for three's roughness-1 PMREM lookup. Against the reference it gives cosine irradiance
 * 6 percent lower facing up and 8 percent lower averaged over the four horizontal directions, and
 * 1.4 times the 0 to 15 degree band a glossy floor mirrors. Only these hemisphere averages are
 * matched: the gradient has no azimuth, so the
 * HDR's lopsided side lighting (one side about four times the others) is not reproduced.
 */
export const PROCEDURAL_ENVIRONMENT_SCALE = 0.927;

export async function composeLighting(options: LightingOptions): Promise<Lighting> {
  // Before the first frame that draws a rect light, or its shader build throws (rect-area-ltc.ts).
  registerRectAreaLights();
  options.renderer.shadowMap.enabled = options.sunShadow;

  let environment: Environment;
  let environmentScale: number;
  const hdrUrl = skySourceFromParam(options.sky ?? null) === 'hdr' ? options.environmentUrl : undefined;
  try {
    if (hdrUrl === undefined) {
      environment = await createProceduralEnvironment(options.renderer);
      environmentScale = PROCEDURAL_ENVIRONMENT_SCALE;
    } else {
      environment = await createHdrEnvironment(options.renderer, hdrUrl);
      environmentScale = HDR_ENVIRONMENT_SCALE;
    }
  } catch (error) {
    console.warn('[archviz] sky environment failed; using the room fallback', error);
    environment = await createRoomEnvironment(options.renderer);
    environmentScale = ROOM_ENVIRONMENT_SCALE;
  }

  let rig: Rig = options.initial === undefined ? DEFAULT_RIG : parseRig(options.initial, DEFAULT_RIG);
  const three: ThreeRig = createThreeRig(rig, {
    shadowMapSize: options.shadowMapSize,
    sunShadow: options.sunShadow,
  });
  options.scene.add(three.group);

  function applyToScene(next: Rig): void {
    rig = next;
    three.apply(next);
    const daylightParams = daylightParameters(next.daylight);
    environment.apply(
      options.scene,
      daylightParams.skyIntensity * environmentScale,
      daylightParams.backgroundIntensity,
    );
    options.renderer.toneMappingExposure = next.exposure;
    options.onChange();
  }
  applyToScene(rig);

  let panel: LightPanelHandle | null = null;
  if (options.panelRoot !== null) {
    panel = mountLightPanel(options.panelRoot, {
      rig,
      onChange: applyToScene,
    });
  }

  return {
    get rig(): Rig {
      return rig;
    },
    apply(next: Rig): void {
      applyToScene(next);
      panel?.setRig(next);
    },
    serialize(): string {
      return serializeRig(rig);
    },
    dispose(): void {
      panel?.dispose();
      options.scene.remove(three.group);
      three.dispose();
      environment.dispose();
    },
  };
}
