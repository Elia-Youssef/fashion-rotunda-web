// Derives the visible HDR sky and preserves the source panorama orientation for lighting.

import { DataTexture, DataUtils, EquirectangularReflectionMapping, FloatType, HalfFloatType } from 'three';
import type { Texture } from 'three';

import { environmentResources } from './environment-resources';

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

  const resources = environmentResources();
  try {
    const background = resources.own(new DataTexture(pixels, backgroundWidth, backgroundHeight, undefined, source.type));
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
    resources.transfer(background);
    return background;
  } finally {
    resources.cleanup();
  }
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
