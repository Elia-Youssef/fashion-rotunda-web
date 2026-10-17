// The procedural sky's shipped energy against the School Field HDR reference: hemisphere fill
// through the compose scale constants, and the 2026-10-14 bounce lobe pinned on top of it.

import { describe, expect, it } from 'vitest';

import { daylightParameters } from '../../src/lighting/rig';

describe('procedural sky calibration', () => {
  // The same cosine-weighted integral as the sky calibration, for an up normal and the mean of four
  // horizontal normals. The HDR's
  // scanlines run from the zenith down; the procedural pixels run from the nadir up (sky.ts).
  function irradiance(
    data: Float32Array,
    width: number,
    height: number,
    rowZeroIsZenith: boolean,
    normal: [number, number, number] = [0, 1, 0],
  ): { up: number; side: number; directional: number } {
    const luma = (i: number): number =>
      0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    let up = 0;
    let side = 0;
    let directional = 0;
    for (let y = 0; y < height; y += 1) {
      const row = rowZeroIsZenith ? y : height - 1 - y;
      const theta = ((row + 0.5) / height) * Math.PI;
      const dOmega = (Math.PI / height) * ((2 * Math.PI) / width) * Math.sin(theta);
      for (let x = 0; x < width; x += 1) {
        const phi = ((x + 0.5) / width) * 2 * Math.PI;
        const dx = Math.sin(theta) * Math.cos(phi);
        const dz = Math.sin(theta) * Math.sin(phi);
        const value = luma(4 * (y * width + x)) * dOmega;
        // EquirectUV's world azimuth is phi - pi, whereas the four-side mean is invariant to this shift.
        directional += value * Math.max(0, -dx * normal[0] + Math.cos(theta) * normal[1] - dz * normal[2]);
        up += value * Math.max(0, Math.cos(theta));
        const facing = Math.max(0, dx) + Math.max(0, -dx) + Math.max(0, dz) + Math.max(0, -dz);
        side += (value * facing) / 4;
      }
    }
    return { up, side, directional };
  }

  async function referenceHdr() {
    const { readFileSync } = await import('node:fs');
    const { FloatType: Float } = await import('three');
    const { HDRLoader } = await import('three/addons/loaders/HDRLoader.js');
    const file = readFileSync(
      new URL('../../public/content/env/school-field-cloudy-1k.hdr', import.meta.url),
    );
    const loader = new HDRLoader();
    loader.setDataType(Float);
    const hdr = loader.parse(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
    const { width, height } = hdr;
    if (width === undefined || height === undefined) throw new Error('the HDR parsed without a size');
    // The runtime loads half floats, and HDRLoader clamps each channel to the float16 maximum.
    const received = Float32Array.from(hdr.data as Float32Array, (value) => Math.min(value, 65504));
    return { received, width, height };
  }

  it('matches the upright, clamped School Field HDR fill within 10 percent, up and sideways', async () => {
    const { HDR_ENVIRONMENT_SCALE, PROCEDURAL_ENVIRONMENT_SCALE } = await import('../../src/lighting/compose');
    const sky = await import('../../src/lighting/sky');
    const { received, width, height } = await referenceHdr();
    const before = irradiance(received, width, height, true);
    const after = irradiance(
      sky.gradientSkyPixels(sky.baseEnvironmentSkyPalette()),
      sky.SKY_WIDTH,
      sky.SKY_HEIGHT,
      false,
    );

    const upRatio = (after.up * PROCEDURAL_ENVIRONMENT_SCALE) / (before.up * HDR_ENVIRONMENT_SCALE);
    const sideRatio =
      (after.side * PROCEDURAL_ENVIRONMENT_SCALE) / (before.side * HDR_ENVIRONMENT_SCALE);
    expect(Math.abs(upRatio - 1)).toBeLessThan(0.1);
    expect(Math.abs(sideRatio - 1)).toBeLessThan(0.1);
    // The adopted calibration (calibration.json, "shipped"): up 0.939, side 0.924.
    expect(upRatio).toBeCloseTo(0.939, 2);
    expect(sideRatio).toBeCloseTo(0.924, 2);

    // Third target: the 0 to 15 degree band a glossy floor mirrors, 1.400 of the HDR's.
    const bandMean = (data: Float32Array, w: number, h: number, rowZeroIsZenith: boolean): number => {
      let sum = 0;
      let weight = 0;
      for (let y = 0; y < h; y += 1) {
        const row = rowZeroIsZenith ? y : h - 1 - y;
        const theta = ((row + 0.5) / h) * Math.PI;
        const elevation = 90 - (theta * 180) / Math.PI;
        if (elevation < 0 || elevation >= 15) continue;
        for (let x = 0; x < w; x += 1) {
          const i = 4 * (y * w + x);
          sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) * Math.sin(theta);
          weight += Math.sin(theta);
        }
      }
      return sum / weight;
    };
    const skyPixels = sky.gradientSkyPixels(sky.baseEnvironmentSkyPalette());
    const bandRatio =
      (bandMean(skyPixels, sky.SKY_WIDTH, sky.SKY_HEIGHT, false) * PROCEDURAL_ENVIRONMENT_SCALE) /
      (bandMean(received, width, height, true) * HDR_ENVIRONMENT_SCALE);
    expect(bandRatio).toBeCloseTo(1.4, 1);
  });

  it("pins the owner's 2026-10-14 C3 bounce choice separately from the base calibration", async () => {
    const { HDR_ENVIRONMENT_SCALE, PROCEDURAL_ENVIRONMENT_SCALE } = await import('../../src/lighting/compose');
    const sky = await import('../../src/lighting/sky');
    const { received, width, height } = await referenceHdr();
    const hdr = irradiance(received, width, height, true);
    const basePixels = sky.gradientSkyPixels(sky.baseEnvironmentSkyPalette());
    const shippedPixels = sky.gradientSkyPixels(sky.environmentSkyPalette());
    const base = irradiance(basePixels, sky.SKY_WIDTH, sky.SKY_HEIGHT, false);
    const shipped = irradiance(shippedPixels, sky.SKY_WIDTH, sky.SKY_HEIGHT, false);
    const sideRatio = shipped.side * PROCEDURAL_ENVIRONMENT_SCALE / (hdr.side * HDR_ENVIRONMENT_SCALE);
    const upRatio = shipped.up * PROCEDURAL_ENVIRONMENT_SCALE / (hdr.up * HDR_ENVIRONMENT_SCALE);
    expect(sideRatio).toBeCloseTo(1.1132086754, 8);
    expect(shipped.side).toBeGreaterThan(base.side);

    // A wall normal toward the sun's antipode must receive more added fill than its opposite.
    const [x, , z] = daylightParameters(0.5).direction;
    const horizontal = Math.hypot(x, z);
    const away: [number, number, number] = [x / horizontal, 0, z / horizontal];
    const toward: [number, number, number] = [-away[0], 0, -away[2]];
    const increase = (normal: [number, number, number]): number =>
      irradiance(shippedPixels, sky.SKY_WIDTH, sky.SKY_HEIGHT, false, normal).directional -
      irradiance(basePixels, sky.SKY_WIDTH, sky.SKY_HEIGHT, false, normal).directional;
    expect(increase(away)).toBeGreaterThan(increase(toward));
    expect(increase(away)).toBeGreaterThan(0);
    expect(Math.abs(upRatio - 1)).toBeLessThan(0.1);
  });
});
