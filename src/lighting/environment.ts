// The environment light: what comes through the dome. Thin on purpose, because none of it can be unit
// tested without a GPU, so every line here is either an API call or a disposal. The default sky is the
// runtime gradient from sky.ts; the School Field HDR is kept only as the ?sky=hdr diagnostic, and
// three's RoomEnvironment only as the failure fallback.
//
// Every factory goes through the WebGPU PMREMGenerator, which three exports from 'three/webgpu'
// (node_modules/three/src/Three.WebGPU.js line 13 re-exports renderers/common/extras/PMREMGenerator.js).
// It throws if the backend is not up yet (PMREMGenerator.js lines 145 and 217 name the cure,
// "await renderer.init()"), so each factory awaits it first. Renderer.init() caches its promise
// (src/renderers/common/Renderer.js lines 784 to 849), so awaiting it again costs nothing.
//
// This is the only module in src/lighting that imports from 'three/webgpu'. Everything the tests read
// imports from 'three'.

import {
  DataTexture,
  DataUtils,
  EquirectangularReflectionMapping,
  FloatType,
  HalfFloatType,
} from 'three';
import type { Scene, Texture } from 'three';
import { PMREMGenerator } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import type { RenderTarget } from 'three';

import { createGradientSkyTexture, environmentSkyPalette, visibleSkyPalette } from './sky';

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
 * `school-field-cloudy` is a complete outdoor panorama: its field begins below the cloud band.
 * It is useful for PMREM lighting, but makes the visible exterior read as a field wrapped around
 * the dome. Keep the zenith unchanged, then extend a cloud-only band across the lower
 * hemisphere of a separate visible texture. The authored treetops begin below this band.
 */
const SKY_PRESERVE_FRACTION = 0.2;
const SKY_SOURCE_LIMIT_FRACTION = 0.245;
/** The visible background is blurred, so a 512-wide derived texture avoids a second large HDR upload. */
const VISIBLE_BACKGROUND_WIDTH = 512;

type HdrPixels = Float32Array | Uint16Array;

interface HdrImage {
  data: HdrPixels;
  width: number;
  height: number;
}

function isHdrImage(image: unknown): image is HdrImage {
  if (typeof image !== 'object' || image === null) return false;
  const candidate = image as { data?: unknown; width?: unknown; height?: unknown };
  const { data, width, height } = candidate;
  return (
    (data instanceof Float32Array || data instanceof Uint16Array) &&
    typeof width === 'number' && Number.isInteger(width) && width > 1 &&
    typeof height === 'number' && Number.isInteger(height) && height > 1
  );
}

function sampleChannel(data: HdrPixels, type: number, index: number): number {
  return type === HalfFloatType ? DataUtils.fromHalfFloat(data[index]) : data[index];
}

function writeChannel(data: HdrPixels, type: number, index: number, value: number): void {
  data[index] = type === HalfFloatType ? DataUtils.toHalfFloat(value) : value;
}

/**
 * Derives the visitor-facing sky from the loaded HDR without modifying that texture. The PMREM
 * still receives the complete panorama, including its ground, for physically useful fill and
 * reflections. This texture contains only the source's clean upper sky and has no network cost.
 */
export function createSkyOnlyBackground(source: Texture): Texture {
  if (!isHdrImage(source.image)) {
    throw new TypeError('HDR background source must be a floating-point data texture');
  }
  if (source.type !== HalfFloatType && source.type !== FloatType) {
    throw new TypeError('HDR background source must use half or full floating-point pixels');
  }

  const { data: sourcePixels, width, height } = source.image;
  const backgroundWidth = Math.min(width, VISIBLE_BACKGROUND_WIDTH);
  const backgroundHeight = Math.min(height, Math.max(2, Math.ceil(backgroundWidth / 2)));
  const pixels: HdrPixels =
    sourcePixels instanceof Float32Array
      ? new Float32Array(backgroundWidth * backgroundHeight * 4)
      : new Uint16Array(backgroundWidth * backgroundHeight * 4);
  const preservedRows = SKY_PRESERVE_FRACTION * (height - 1);
  const sourceLimitRows = SKY_SOURCE_LIMIT_FRACTION * (height - 1);

  for (let y = 0; y < backgroundHeight; y += 1) {
    const fraction = y / (backgroundHeight - 1);
    const sourceRow =
      fraction <= SKY_PRESERVE_FRACTION
        ? fraction * (height - 1)
        : preservedRows +
          ((fraction - SKY_PRESERVE_FRACTION) / (1 - SKY_PRESERVE_FRACTION)) *
            (sourceLimitRows - preservedRows);
    const lowerRow = Math.floor(sourceRow);
    const upperRow = Math.min(height - 1, lowerRow + 1);
    const blend = sourceRow - lowerRow;

    for (let x = 0; x < backgroundWidth; x += 1) {
      const sourceColumn = (x / (backgroundWidth - 1)) * (width - 1);
      const lowerColumn = Math.floor(sourceColumn);
      const upperColumn = Math.min(width - 1, lowerColumn + 1);
      const horizontalBlend = sourceColumn - lowerColumn;
      const destination = 4 * (y * backgroundWidth + x);
      const lowerLeft = 4 * (lowerRow * width + lowerColumn);
      const lowerRight = 4 * (lowerRow * width + upperColumn);
      const upperLeft = 4 * (upperRow * width + lowerColumn);
      const upperRight = 4 * (upperRow * width + upperColumn);
      for (let channel = 0; channel < 4; channel += 1) {
        const lowerValue = sampleChannel(sourcePixels, source.type, lowerLeft + channel) +
          (sampleChannel(sourcePixels, source.type, lowerRight + channel) -
            sampleChannel(sourcePixels, source.type, lowerLeft + channel)) * horizontalBlend;
        const upperValue = sampleChannel(sourcePixels, source.type, upperLeft + channel) +
          (sampleChannel(sourcePixels, source.type, upperRight + channel) -
            sampleChannel(sourcePixels, source.type, upperLeft + channel)) * horizontalBlend;
        writeChannel(pixels, source.type, destination + channel, lowerValue + (upperValue - lowerValue) * blend);
      }
    }
  }

  const background = new DataTexture(pixels, backgroundWidth, backgroundHeight, undefined, source.type);
  background.name = `${source.name || 'HDR'} visible sky`;
  background.mapping = source.mapping;
  background.colorSpace = source.colorSpace;
  background.flipY = source.flipY;
  background.wrapS = source.wrapS;
  background.wrapT = source.wrapT;
  background.magFilter = source.magFilter;
  background.minFilter = source.minFilter;
  background.anisotropy = source.anisotropy;
  background.generateMipmaps = source.generateMipmaps;
  background.needsUpdate = true;
  return background;
}

/**
 * Sets the equirectangular mapping and keeps HDRLoader's flipY = true. The file's first scanlines
 * are sky; both backends upload the first row at v = 0 unless flipY is set, and three r186
 * equirectUV maps v = 0 to straight down, so flipY = false (from the 2026-09-23 integration until
 * that day's sky change) put the field overhead and tinted the lit room olive. The dome "terrain"
 * that once looked like an upside-down HDR was the then-metallic dome glass mirroring the lower
 * hemisphere.
 * A probe build (green zenith, red ground, rows written top-down) showed a red dome on both backends.
 */
export function orientHdrEquirectangular(texture: Texture): void {
  texture.mapping = EquirectangularReflectionMapping;
}

export function fromRenderTarget(
  target: RenderTarget,
  background: Texture | null = null,
  source: Texture | null = null,
): Environment {
  return {
    texture: target.texture,
    apply(scene: Scene, intensity: number, backgroundIntensity = 0.25): void {
      scene.environment = target.texture;
      scene.environmentIntensity = intensity;
      if (background !== null) {
        // The PMREM carries the lighting sky; the separate background texture is what visitors see
        // through the glazed dome. Any blurriness above 0 sends an equirectangular background
        // through pmremTexture rather than cubeMapNode (three r186 src/renderers/common/nodes/
        // NodeManager.js lines 713 to 727), so the background and the lighting share one PMREM
        // orientation (first uploaded row at the nadir); on the smooth gradient the blur is invisible.
        scene.background = background;
        // Both skies' visible copies are authored in HDR radiance units; the rig's background
        // curve keeps them below the lighting strength so the dome does not clip to a flat white.
        scene.backgroundIntensity = backgroundIntensity;
        scene.backgroundBlurriness = 0.08;
      }
    },
    dispose(): void {
      // The target owns the lighting PMREM; the visible background and original HDR are separate.
      target.dispose();
      background?.dispose();
      if (source !== background) source?.dispose();
    },
  };
}

/**
 * The fallback sky: three's own RoomEnvironment, prefiltered. Production generates its sky (sky.ts)
 * and loads the HDR only under ?sky=hdr; this keeps a failed environment build lit instead of
 * aborting the showroom.
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
 * The default sky: two gradient textures generated in memory (sky.ts), no network request. The
 * lighting copy goes through the same PMREMGenerator.fromEquirectangular path the HDR used; the
 * visible copy, bluer and with a pale horizon, becomes scene.background.
 */
export async function createProceduralEnvironment(renderer: WebGPURenderer): Promise<Environment> {
  await renderer.init();
  const source = createGradientSkyTexture(environmentSkyPalette(), 'procedural sky lighting');
  const background = createGradientSkyTexture(visibleSkyPalette(), 'procedural sky visible');
  const generator = new PMREMGenerator(renderer);
  const target = generator.fromEquirectangular(source);
  generator.dispose();
  // fromEquirectangular renders the cube faces inside this call once the backend is up, so the
  // upload of the lighting copy has already been issued (WebGL texImage2D and WebGPU writeTexture
  // copy the data when called). Only the PMREM target is sampled afterwards: release the source
  // and its 1 MB CPU array now rather than holding both for the page's life. The visible copy
  // stays, because the background samples it every frame.
  source.dispose();
  return fromRenderTarget(target, background);
}

/**
 * The ?sky=hdr diagnostic: the School Field HDR the default sky replaced. HDRLoader is the current
 * name for the Radiance .hdr reader: r186 marks
 * RGBELoader deprecated in favour of it (@types/three/examples/jsm/loaders/RGBELoader.d.ts says so, and
 * RGBELoader.js is a two line subclass of HDRLoader.js), so the planned RGBELoader would have shipped a
 * deprecation. UltraHDRLoader was the other candidate and is not used: the authored asset is a linear
 * EXR and the deterministic pipeline converts it to the Radiance HDR both render backends already read.
 */
export async function createHdrEnvironment(renderer: WebGPURenderer, url: string): Promise<Environment> {
  await renderer.init();
  const source = await new HDRLoader().loadAsync(url);
  orientHdrEquirectangular(source);
  const background = createSkyOnlyBackground(source);
  const generator = new PMREMGenerator(renderer);
  const target = generator.fromEquirectangular(source);
  generator.dispose();
  return fromRenderTarget(target, background, source);
}
