// The lighting composition: one call stands the studio rig, the environment and the panel up around a
// scene, and one dispose takes them down. Glue over the rest of src/lighting, nothing more; it reaches
// 'three/webgpu' through rect-area-ltc and environment, so it never runs under the node tests.

import type { Scene } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

import { mountLightPanel } from '../ui/lightpanel';
import type { LightPanelHandle } from '../ui/lightpanel';
import { createRoomEnvironment } from './environment';
import type { Environment } from './environment';
import { LIGHTING_PRESETS, PRESET_ORDER } from './presets';
import { registerRectAreaLights } from './rect-area-ltc';
import { DEFAULT_RIG, parseRig, serializeRig, skyIntensity } from './rig';
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
 * so a casting pane would black out the sun that the room is built to let in. Called once per loaded
 * object by whoever adds geometry to the scene.
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
 * floods the marble. This factor maps the panel's sky value to scene.environmentIntensity and is the
 * one knob for that, tuned by eye against docs/reference on 2026-09-19.
 */
const ENVIRONMENT_SCALE = 0.35;

export async function composeLighting(options: LightingOptions): Promise<Lighting> {
  // Before the first frame that draws a rect light, or its shader build throws (rect-area-ltc.ts).
  registerRectAreaLights();
  options.renderer.shadowMap.enabled = options.sunShadow;

  const environment: Environment = await createRoomEnvironment(options.renderer);
  let rig: Rig = options.initial === undefined ? DEFAULT_RIG : parseRig(options.initial, DEFAULT_RIG);
  const three: ThreeRig = createThreeRig(rig, {
    shadowMapSize: options.shadowMapSize,
    sunShadow: options.sunShadow,
  });
  options.scene.add(three.group);

  function updatePresetSelect(currentRig: Rig): void {
    if (options.panelRoot === null) return;
    const select = options.panelRoot.querySelector<HTMLSelectElement>('.lightpanel__select');
    if (select === null) return;
    const currentSerialized = serializeRig(currentRig);
    const match = PRESET_ORDER.find((name) => serializeRig(LIGHTING_PRESETS[name]) === currentSerialized);
    select.value = match ?? '';
  }

  function applyToScene(next: Rig): void {
    rig = next;
    three.apply(next);
    environment.apply(options.scene, skyIntensity(next) * ENVIRONMENT_SCALE);
    options.renderer.toneMappingExposure = next.exposure;
    updatePresetSelect(next);
    options.onChange();
  }
  applyToScene(rig);

  let panel: LightPanelHandle | null = null;
  if (options.panelRoot !== null) {
    panel = mountLightPanel(options.panelRoot, {
      rig,
      onChange: applyToScene,
      presets: LIGHTING_PRESETS,
    });
    updatePresetSelect(rig);
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
