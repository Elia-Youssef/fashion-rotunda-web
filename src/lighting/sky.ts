// The procedural sky: a small equirectangular gradient generated at runtime, with no download. It
// replaces the School Field HDR as the source of scene.environment and scene.background, because
// that panorama's field and tree line fed an olive-green fill and grazing reflection into the white
// marble. The Unreal level has no HDRI at all: it lights the room from a SkyAtmosphere, a real-time
// SkyLight capture of it (lower hemisphere not forced black) and a height fog whose albedo is
// 153,190,231 (read from the Unreal level). A clear blue gradient over
// a neutral ground is the closer stand-in.
//
// Everything here except createGradientSkyTexture is pure arithmetic and is unit tested. Every
// colour and falloff is a named constant in this one block so a later calibration can tune them.
//
// Orientation: row 0 of the pixel array is the nadir and the texture keeps flipY false. Both backends
// upload the first row at v = 0 (WebGL with UNPACK_FLIP_Y_WEBGL false, WebGPU copyBufferToTexture
// without its flip), and equirectUV (three r186 src/nodes/utils/EquirectUV.js) maps v = 0 to straight
// down. A probe build with a green zenith and a red ground, rows written top-down, showed a red dome on
// both backends; the rows are therefore
// written bottom-up. The same probe explains the School Field HDR's olive cast: HDRLoader delivers its
// scanlines top-down, so the flipY = false it once received put the field overhead (environment.ts).

import {
  Color,
  DataTexture,
  DataUtils,
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
} from 'three';

/** Straight up: a clear midday blue, the Rayleigh sky seen through the dome. sRGB hex. */
export const SKY_ZENITH_HEX = 0x4a7fc4;
/**
 * The horizon haze: the Unreal height fog albedo #99BEE7, desaturated toward white so the lower sky
 * reads as pale haze rather than a second blue. sRGB hex.
 */
export const SKY_HORIZON_HEX = 0xc6d8ec;
/** Below the horizon: a neutral mid grey, never black, and no green or yellow. sRGB hex. */
export const SKY_GROUND_HEX = 0x808080;

/**
 * The visible sky's linear luminance per band, in the radiance units of the School Field HDR it
 * replaces (that file's upper sky rows average about 2.3), so the dome keeps the level the rig's
 * backgroundIntensity curve was tuned against. The horizon is the brightest band, as in a clear sky.
 */
export const VISIBLE_ZENITH_LUMINANCE = 2.0;
export const VISIBLE_HORIZON_LUMINANCE = 2.6;
export const VISIBLE_GROUND_LUMINANCE = 0.55;
/**
 * Above the horizon the weight toward the zenith is sin(elevation) ** falloff: below 1 the blue takes
 * over a few degrees up. Below the horizon the weight toward the ground is sin(-elevation) **
 * GROUND_FALLOFF: a small value closes the haze into the ground within a few degrees.
 */
export const VISIBLE_SKY_FALLOFF = 0.55;
export const GROUND_FALLOFF = 0.3;

/**
 * The lighting sky's relative luminance per band (zenith 1). The shape is calibrated, not chosen by
 * eye: a calibration script compares the upright,
 * float16-clamped HDR and this sky on three targets: cosine irradiance facing up (0.94 of the HDR)
 * and sideways (0.92), and the 0 to 15 degree band a glossy floor mirrors (1.4). The dim horizon keeps
 * that band near the HDR's dark treeline, so floor reflections and the sun pattern keep their
 * contrast; the ground at 0.09 holds the side fill inside 10 percent. The absolute level is
 * PROCEDURAL_ENVIRONMENT_SCALE in compose.ts. The visible copy uses the VISIBLE_* constants only.
 */
export const ENVIRONMENT_ZENITH_LUMINANCE = 1;
export const ENVIRONMENT_HORIZON_LUMINANCE = 0.03;
export const ENVIRONMENT_GROUND_LUMINANCE = 0.09;
export const ENVIRONMENT_SKY_FALLOFF = 1.0;

/**
 * The lighting copy keeps this share of each colour's saturation. The visible sky wants a clear blue;
 * the fill it throws on white marble and pale garments has to stay near neutral, because this room has
 * no bounce light to warm the shade the way Unreal's Lumen does.
 */
export const ENVIRONMENT_SATURATION = 0.09;

/**
 * Pixel size. PMREMGenerator sizes its cube from image.width / 4 (three r186
 * src/renderers/common/extras/PMREMGenerator.js line 354), so 512 gives a 128 cube, plenty for a
 * smooth gradient; the background copy is the same size.
 */
export const SKY_WIDTH = 512;
export const SKY_HEIGHT = 256;

export type Rgb = [number, number, number];

const LUMA: Rgb = [0.2126, 0.7152, 0.0722];

export function luminance(rgb: Rgb): number {
  return LUMA[0] * rgb[0] + LUMA[1] * rgb[1] + LUMA[2] * rgb[2];
}

/** An sRGB hex colour as linear Rec.709 RGB, rescaled to the given linear luminance. */
export function linearAtLuminance(hex: number, targetLuminance: number): Rgb {
  const color = new Color().setHex(hex);
  const rgb: Rgb = [color.r, color.g, color.b];
  const scale = targetLuminance / luminance(rgb);
  return [rgb[0] * scale, rgb[1] * scale, rgb[2] * scale];
}

/** Moves a colour toward the grey of equal luminance; 1 keeps it, 0 makes it neutral. */
export function withSaturation(rgb: Rgb, saturation: number): Rgb {
  const y = luminance(rgb);
  return [
    y + (rgb[0] - y) * saturation,
    y + (rgb[1] - y) * saturation,
    y + (rgb[2] - y) * saturation,
  ];
}

export interface SkyPalette {
  zenith: Rgb;
  horizon: Rgb;
  ground: Rgb;
  /** Exponent on sin(elevation) above the horizon. */
  skyFalloff: number;
}

/** The visible sky: the three colours at full saturation and the visible luminances. */
export function visibleSkyPalette(): SkyPalette {
  return {
    zenith: linearAtLuminance(SKY_ZENITH_HEX, VISIBLE_ZENITH_LUMINANCE),
    horizon: linearAtLuminance(SKY_HORIZON_HEX, VISIBLE_HORIZON_LUMINANCE),
    ground: linearAtLuminance(SKY_GROUND_HEX, VISIBLE_GROUND_LUMINANCE),
    skyFalloff: VISIBLE_SKY_FALLOFF,
  };
}

/** The lighting sky: the same hues desaturated by ENVIRONMENT_SATURATION, at the calibrated shape. */
export function environmentSkyPalette(): SkyPalette {
  const color = (hex: number, level: number): Rgb =>
    withSaturation(linearAtLuminance(hex, level), ENVIRONMENT_SATURATION);
  return {
    zenith: color(SKY_ZENITH_HEX, ENVIRONMENT_ZENITH_LUMINANCE),
    horizon: color(SKY_HORIZON_HEX, ENVIRONMENT_HORIZON_LUMINANCE),
    ground: color(SKY_GROUND_HEX, ENVIRONMENT_GROUND_LUMINANCE),
    skyFalloff: ENVIRONMENT_SKY_FALLOFF,
  };
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Radiance for a direction whose elevation sine is `sinElevation` (1 up, 0 horizon, -1 down). */
export function skyRadiance(palette: SkyPalette, sinElevation: number): Rgb {
  const s = Math.min(1, Math.max(-1, sinElevation));
  if (s >= 0) {
    return mix(palette.horizon, palette.zenith, Math.pow(s, palette.skyFalloff));
  }
  return mix(palette.horizon, palette.ground, Math.pow(-s, GROUND_FALLOFF));
}

/**
 * The equirectangular pixels as linear RGBA floats, row 0 at the nadir and the last row at the zenith
 * (see the orientation note above). Each row samples its centre, so no row lands exactly on a pole or
 * on the horizon. The gradient has no azimuth term.
 */
export function gradientSkyPixels(palette: SkyPalette, width = SKY_WIDTH, height = SKY_HEIGHT): Float32Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 2) {
    throw new RangeError(`gradientSkyPixels: bad size ${String(width)} x ${String(height)}`);
  }
  const pixels = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const elevation = ((y + 0.5) / height - 0.5) * Math.PI;
    const rgb = skyRadiance(palette, Math.sin(elevation));
    for (let x = 0; x < width; x += 1) {
      const index = 4 * (y * width + x);
      pixels[index] = rgb[0];
      pixels[index + 1] = rgb[1];
      pixels[index + 2] = rgb[2];
      pixels[index + 3] = 1;
    }
  }
  return pixels;
}

/**
 * The pixels as a half-float DataTexture ready for PMREMGenerator.fromEquirectangular or for
 * scene.background. Half float is what HDRLoader hands the same path by default, and it filters
 * linearly on WebGL 2 without the float-linear extension.
 */
export function createGradientSkyTexture(palette: SkyPalette, name: string): DataTexture {
  const floats = gradientSkyPixels(palette);
  const halves = new Uint16Array(floats.length);
  for (let i = 0; i < floats.length; i += 1) {
    halves[i] = DataUtils.toHalfFloat(floats[i]);
  }
  const texture = new DataTexture(halves, SKY_WIDTH, SKY_HEIGHT, undefined, HalfFloatType);
  texture.name = name;
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = LinearSRGBColorSpace;
  texture.flipY = false;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

export type SkySource = 'procedural' | 'hdr';

/**
 * The raw `?sky=` value: `hdr` restores the School Field HDR as a diagnostic; anything else is the
 * procedural sky.
 */
export function skySourceFromParam(value: string | null): SkySource {
  return value === 'hdr' ? 'hdr' : 'procedural';
}

/** skySourceFromParam read from a location.search string. */
export function skySourceFromSearch(search: string): SkySource {
  return skySourceFromParam(new URLSearchParams(search).get('sky'));
}
