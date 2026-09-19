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
  apply(scene: Scene, intensity: number): void;
  dispose(): void;
}

/**
 * A blur radius in radians applied to the room before the prefilter (PMREMGenerator.js line 118 documents
 * the parameter). The room is flat painted boxes with hard edges, and a small blur turns them into the
 * soft gradient an interior wants instead of eight visible walls in every reflection.
 */
const ROOM_BLUR_RADIANS = 0.04;

function fromRenderTarget(target: RenderTarget): Environment {
  return {
    texture: target.texture,
    apply(scene: Scene, intensity: number): void {
      scene.environment = target.texture;
      scene.environmentIntensity = intensity;
    },
    dispose(): void {
      // Disposing the target disposes the texture it owns; nothing else here holds GPU memory.
      target.dispose();
    },
  };
}

/**
 * The stand-in sky: three's own RoomEnvironment, prefiltered. It is the default until the user supplies an
 * HDR of the real dome, and it costs no download at all.
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
 * The real sky, once there is one. HDRLoader is the current name for the Radiance .hdr reader: r186 marks
 * RGBELoader deprecated in favour of it (@types/three/examples/jsm/loaders/RGBELoader.d.ts says so, and
 * RGBELoader.js is a two line subclass of HDRLoader.js), so the planned RGBELoader would have shipped a
 * deprecation. UltraHDRLoader was the other candidate and is not used: a gain map JPEG is smaller, but it
 * arrives as an sRGB image plus a gain map and the pipeline that writes one is G1.6's, not this goal's.
 */
export async function createHdrEnvironment(renderer: WebGPURenderer, url: string): Promise<Environment> {
  await renderer.init();
  const source = await new HDRLoader().loadAsync(url);
  source.mapping = EquirectangularReflectionMapping;
  const generator = new PMREMGenerator(renderer);
  const target = generator.fromEquirectangular(source);
  // The prefiltered target holds everything the scene reads; the source texture is a CPU side copy now.
  source.dispose();
  generator.dispose();
  return fromRenderTarget(target);
}
