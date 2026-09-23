// The environment light: what comes through the dome. Thin on purpose, because none of it can be unit
// tested without a GPU, so every line here is either an API call or a disposal.
//
// Both factories go through the WebGPU PMREMGenerator, which three exports from 'three/webgpu'
// (node_modules/three/src/Three.WebGPU.js line 13 re-exports renderers/common/extras/PMREMGenerator.js).
// It throws if the backend is not up yet (PMREMGenerator.js lines 145 and 217 name the cure,
// "await renderer.init()"), so both factories await it first. Renderer.init() caches its promise
// (src/renderers/common/Renderer.js lines 784 to 849), so awaiting it again costs nothing.
//
// This is the only module in src/lighting that imports from 'three/webgpu'. Everything the tests read
// imports from 'three'.

import { EquirectangularReflectionMapping } from 'three';
import type { Scene, Texture } from 'three';
import { PMREMGenerator } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import type { RenderTarget } from 'three';

export interface Environment {
  texture: Texture;
  /** Assigns the map and its strength. Intensity comes from the rig's sky entry, through skyIntensity(). */
  apply(scene: Scene, intensity: number, backgroundIntensity?: number): void;
  dispose(): void;
}

/**
 * A blur radius in radians applied to the room before the prefilter (PMREMGenerator.js line 118 documents
 * the parameter). The room is flat painted boxes with hard bright panels; at the example default of 0.04
 * every panel came back as a white splotch on the satin garments, so the blur is wide enough to turn them
 * into the soft gradient a showroom sky wants.
 */
const ROOM_BLUR_RADIANS = 0.3;

/**
 * The authored panorama has sky in its first scanlines, but HDRLoader's default flipY=true puts
 * the ground at the dome zenith after three r186's PMREM/background conversion. Clear that flag
 * before either PMREM path sees the source. The manual environment target used for lighting and
 * the blur-triggered background target then keep the same upright orientation. The up/horizon/
 * down browser captures in both backends verify this renderer-specific choice.
 */
export function orientHdrEquirectangular(texture: Texture): void {
  texture.mapping = EquirectangularReflectionMapping;
  texture.flipY = false;
}

export function fromRenderTarget(target: RenderTarget, background: Texture | null = null): Environment {
  return {
    texture: target.texture,
    apply(scene: Scene, intensity: number, backgroundIntensity = 0.25): void {
      scene.environment = target.texture;
      scene.environmentIntensity = intensity;
      if (background !== null) {
        // The PMREM is correct for material lighting; the original equirectangular texture is the
        // sharp source the visitor sees through the glazed dome. A little blur hides 1K sampling
        // without turning the sky back into the featureless RoomEnvironment stand-in.
        scene.background = background;
        // The source sky contains values far above display white. Keeping the visible copy below
        // the lighting strength preserves cloud detail through the dome instead of clipping it
        // into a flat white ceiling; the PMREM still receives the source at full range.
        scene.backgroundIntensity = backgroundIntensity;
        scene.backgroundBlurriness = 0.08;
      }
    },
    dispose(): void {
      // The target owns the PMREM texture; the optional background is the original HDR source.
      target.dispose();
      background?.dispose();
    },
  };
}

/**
 * The no-download fallback sky: three's own RoomEnvironment, prefiltered. Production supplies an HDR,
 * but this keeps local experiments and content-load failures lit instead of aborting the showroom.
 */
export async function createRoomEnvironment(renderer: WebGPURenderer): Promise<Environment> {
  await renderer.init();
  const generator = new PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const target = generator.fromScene(room, ROOM_BLUR_RADIANS);
  room.dispose();
  generator.dispose();
  return fromRenderTarget(target);
}

/**
 * The shipped sky. HDRLoader is the current name for the Radiance .hdr reader: r186 marks
 * RGBELoader deprecated in favour of it (@types/three/examples/jsm/loaders/RGBELoader.d.ts says so, and
 * RGBELoader.js is a two line subclass of HDRLoader.js), so the planned RGBELoader would have shipped a
 * deprecation. UltraHDRLoader was the other candidate and is not used: the authored asset is a linear
 * EXR and the deterministic pipeline converts it to the Radiance HDR both render backends already read.
 */
export async function createHdrEnvironment(renderer: WebGPURenderer, url: string): Promise<Environment> {
  await renderer.init();
  const source = await new HDRLoader().loadAsync(url);
  orientHdrEquirectangular(source);
  const generator = new PMREMGenerator(renderer);
  const target = generator.fromEquirectangular(source);
  generator.dispose();
  return fromRenderTarget(target, source);
}
