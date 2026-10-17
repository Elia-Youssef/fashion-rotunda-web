// The environment light: what comes through the dome. Factories own their work until the environment
// is ready, and release it on failure. The default sky is the
// runtime gradient from sky.ts; the School Field HDR is kept only as the ?sky=hdr diagnostic, and
// three's RoomEnvironment only as the failure fallback.
//
// Every factory goes through the WebGPU PMREMGenerator, which three exports from 'three/webgpu'
// (node_modules/three/src/Three.WebGPU.js line 13 re-exports renderers/common/extras/PMREMGenerator.js).
// It throws if the backend is not up yet (PMREMGenerator.js lines 145 and 217 name the cure,
// "await renderer.init()"), so each factory awaits it first. Renderer.init() caches its promise
// (src/renderers/common/Renderer.js lines 784 to 849), so awaiting it again costs nothing.
//
// In src/lighting, only this module and rect-area-ltc.ts import values from 'three/webgpu';
// compose.ts imports a type from it. The ownership ledger in environment-resources.ts has no imports,
// and visible-sky.ts uses only 'three' and that ledger for the HDR background derivation.

import {
  CubeUVReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  RenderTarget,
  RGBAFormat,
} from 'three';
import type { DataTexture, Scene, Texture } from 'three';
import { PMREMGenerator } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';

import { lazyImport } from '../ui/lazy-import';
import { environmentResources } from './environment-resources';
import type { EnvironmentResources } from './environment-resources';
import { createGradientSkyTexture, environmentSkyPalette, skyDaylightValue, SKY_REFERENCE_DAYLIGHT } from './sky';
import { createProceduralSkyBackground, createSkyOnlyBackground, orientHdrEquirectangular } from './visible-sky';

// Keep the visible-sky helpers on the public environment facade for callers that mock its factories.
export { createSkyOnlyBackground, orientHdrEquirectangular } from './visible-sky';

export interface Environment {
  texture: Texture;
  /** Procedural skies only: rebuild on a changed value, retaining the last output if conversion fails. */
  updateDaylight?(daylight: number): void;
  /** Assigns the map and its strength. Intensity comes from daylightParameters(...).skyIntensity. */
  apply(scene: Scene, intensity: number, backgroundIntensity?: number): void;
  dispose(): void;
}

/**
 * A blur radius in radians applied to the room before the prefilter (PMREMGenerator.js lines 118-119 document
 * the parameter). The room is flat painted boxes with hard bright panels; at the example default of 0.04
 * every panel came back as a white splotch on the satin garments, so the blur is wide enough to turn them
 * into the soft gradient a showroom sky wants.
 */
const ROOM_BLUR_RADIANS = 0.3;

// Match three r186 PMREMGenerator's _setSize, _allocateTarget and _createRenderTarget (lines
// 359-363, 407-415 and 838-855). Supplying the public renderTarget argument keeps the output owned
// even when conversion throws before returning it; generator.dispose() frees only its internals.
const ROOM_CUBE_SIZE = 256;
const EQUIRECTANGULAR_FACE_DIVISOR = 4;
const CUBE_UV_COLUMNS = 3;
const CUBE_UV_ROWS = 4;
const CUBE_UV_MIN_TILE_SIZE = 16;
const CUBE_UV_MIN_TILES = 7;

function createPmremTarget(resources: EnvironmentResources, faceSize: number, depthBuffer: boolean): RenderTarget {
  const cubeSize = 2 ** Math.floor(Math.log2(faceSize));
  const width = CUBE_UV_COLUMNS * Math.max(cubeSize, CUBE_UV_MIN_TILE_SIZE * CUBE_UV_MIN_TILES);
  const target = resources.own(new RenderTarget(width, CUBE_UV_ROWS * cubeSize, {
    magFilter: LinearFilter,
    minFilter: LinearFilter,
    generateMipmaps: false,
    type: HalfFloatType,
    format: RGBAFormat,
    colorSpace: LinearSRGBColorSpace,
    depthBuffer,
  }));
  target.texture.mapping = CubeUVReflectionMapping;
  target.texture.name = 'PMREM.cubeUv';
  Object.assign(target.texture, { isPMREMTexture: true });
  target.scissorTest = true;
  return target;
}

/** PMREM restores renderer state only on success; restore it before releasing a failed output. */
function convertPmrem(renderer: WebGPURenderer, convert: () => void): void {
  const previous = renderer.getRenderTarget();
  const face = renderer.getActiveCubeFace();
  const level = renderer.getActiveMipmapLevel();
  const autoClear = renderer.autoClear;
  try {
    convert();
  } catch (error) {
    try {
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(previous, face, level);
    } catch (restoreError) {
      console.warn('[archviz] environment render target restore failed', restoreError);
    }
    throw error;
  }
}

export function fromRenderTarget(
  target: RenderTarget,
  background: Texture | null = null,
  source: Texture | null = null,
): Environment {
  const scenes = new Set<Scene>();
  const retained = environmentResources();
  retained.own(target);
  if (background !== null) retained.own(background);
  if (source !== null) retained.own(source);
  return {
    texture: target.texture,
    apply(scene: Scene, intensity: number, backgroundIntensity = 0.25): void {
      scenes.add(scene);
      scene.environment = target.texture;
      scene.environmentIntensity = intensity;
      if (background !== null) {
        // The PMREM carries the lighting sky; the separate background texture is what visitors see
        // through the glazed dome. Any blurriness above 0 sends an equirectangular background
        // through pmremTexture rather than cubeMapNode (three r186 src/renderers/common/nodes/
        // NodeManager.js lines 713 to 733), so the background and the lighting share one PMREM
        // orientation (first uploaded row at the nadir); on the smooth gradient the blur is invisible.
        scene.background = background;
        // Both skies' visible copies are authored in HDR radiance units; the rig's background
        // curve keeps them below the lighting strength so the dome does not clip to a flat white.
        scene.backgroundIntensity = backgroundIntensity;
        scene.backgroundBlurriness = 0.08;
      }
    },
    dispose(): void {
      for (const scene of scenes) {
        if (scene.environment === target.texture) scene.environment = null;
        if (background !== null && scene.background === background) scene.background = null;
      }
      scenes.clear();
      // The target owns the lighting PMREM; the visible background and original HDR are separate.
      retained.cleanup();
    },
  };
}

/**
 * The fallback sky: three's own RoomEnvironment, prefiltered. Production generates its sky (sky.ts)
 * and loads the HDR only under ?sky=hdr; this keeps a failed environment build lit instead of
 * aborting the showroom.
 */
const loadRoomModule = lazyImport(() => import('three/addons/environments/RoomEnvironment.js'));

export async function createRoomEnvironment(renderer: WebGPURenderer): Promise<Environment> {
  await renderer.init();
  const { RoomEnvironment } = await loadRoomModule();
  const resources = environmentResources();
  try {
    const generator = resources.own(new PMREMGenerator(renderer));
    const room = resources.own(new RoomEnvironment());
    const target = createPmremTarget(resources, ROOM_CUBE_SIZE, true);
    convertPmrem(renderer, () => {
      generator.fromScene(room, ROOM_BLUR_RADIANS, undefined, undefined, { renderTarget: target });
    });
    resources.release(room);
    resources.release(generator);
    const environment = fromRenderTarget(target);
    resources.transfer(target);
    return environment;
  } finally {
    resources.cleanup();
  }
}

/**
 * The default sky: two gradient textures generated in memory (sky.ts), no network request. The
 * lighting copy goes through the same PMREMGenerator.fromEquirectangular path the HDR used; the
 * visible copy, bluer and with a pale horizon, becomes scene.background.
 */
export async function createProceduralEnvironment(renderer: WebGPURenderer): Promise<Environment> {
  await renderer.init();
  let daylight = SKY_REFERENCE_DAYLIGHT;
  let current = buildProceduralEnvironment(renderer, daylight);
  let disposed = false;
  return {
    get texture(): Texture { return current.texture; },
    updateDaylight(value: number): void {
      const next = skyDaylightValue(value);
      if (disposed || next === daylight) return;
      // Build before handoff: failed conversion releases only its own resources.
      const replacement = buildProceduralEnvironment(renderer, next);
      const previous = current;
      current = replacement;
      daylight = next;
      previous.dispose();
    },
    apply(scene: Scene, intensity: number, backgroundIntensity?: number): void {
      if (!disposed) current.apply(scene, intensity, backgroundIntensity);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      current.dispose();
    },
  };
}

/** Each rebuild owns its candidate independently until every construction step succeeds. */
function buildProceduralEnvironment(renderer: WebGPURenderer, daylight: number): Environment {
  const resources = environmentResources();
  try {
    const source = resources.own(createGradientSkyTexture(environmentSkyPalette(daylight), 'procedural sky lighting'));
    const background = resources.own(createProceduralSkyBackground(daylight));
    const generator = resources.own(new PMREMGenerator(renderer));
    const target = createPmremTarget(resources, source.image.width / EQUIRECTANGULAR_FACE_DIVISOR, false);
    convertPmrem(renderer, () => { generator.fromEquirectangular(source, target); });
    resources.release(generator);
    // fromEquirectangular renders the cube faces inside this call once the backend is up, so the
    // upload of the lighting copy has already been issued (WebGL texImage2D and WebGPU writeTexture
    // copy the data when called). Only the PMREM target is sampled afterwards: release the source
    // now rather than retaining its texture and 1 MB CPU array for the page's life. The visible copy
    // stays, because the background samples it every frame.
    resources.release(source);
    const environment = fromRenderTarget(target, background);
    resources.transfer(target, background);
    return environment;
  } finally {
    resources.cleanup();
  }
}

/**
 * The ?sky=hdr diagnostic: the School Field HDR the default sky replaced. HDRLoader is the current
 * name for the Radiance .hdr reader: r186 marks
 * RGBELoader deprecated in favour of it (@types/three/examples/jsm/loaders/RGBELoader.d.ts says so, and
 * RGBELoader.js is a two line subclass of HDRLoader.js), so the planned RGBELoader would have shipped a
 * deprecation. UltraHDRLoader was the other candidate and is not used: the authored asset is a linear
 * EXR and the deterministic pipeline converts it to the Radiance HDR both render backends already read.
 */
const loadHdrLoader = lazyImport(() => import('three/addons/loaders/HDRLoader.js'));

export async function createHdrEnvironment(renderer: WebGPURenderer, url: string): Promise<Environment> {
  await renderer.init();
  const { HDRLoader } = await loadHdrLoader();
  const resources = environmentResources();
  try {
    // DataTextureLoader.load returns the texture before its request settles (three r186 lines
    // 48-93). loadAsync hides it on rejection, so retain that same texture before awaiting it.
    const source = await new Promise<DataTexture>((resolve, reject) => {
      resources.own(new HDRLoader().load(url, resolve, undefined, reject));
    });
    orientHdrEquirectangular(source);
    const background = resources.own(createSkyOnlyBackground(source));
    const generator = resources.own(new PMREMGenerator(renderer));
    const target = createPmremTarget(resources, source.image.width / EQUIRECTANGULAR_FACE_DIVISOR, false);
    convertPmrem(renderer, () => { generator.fromEquirectangular(source, target); });
    resources.release(generator);
    const environment = fromRenderTarget(target, background, source);
    resources.transfer(target, background, source);
    return environment;
  } finally {
    resources.cleanup();
  }
}
