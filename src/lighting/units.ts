// Physical light units and the axis change from the Unreal level to the three.js scene. Pure arithmetic:
// no three.js import, no DOM, so every number here is testable in node.
//
// Units, read in the installed three.js 0.186.0 sources:
// - PointLight.intensity is candela (cd). node_modules/three/src/lights/PointLight.js line 25.
// - RectAreaLight.intensity is nits (cd/m2). src/lights/RectAreaLight.js lines 79 and 86: power is
//   intensity * width * height * PI, so intensity is luminance, not luminous intensity.
// - DirectionalLight.intensity is lux (lm/m2). three carries glTF KHR_lights_punctual intensities through
//   unchanged in both directions, examples/jsm/loaders/GLTFLoader.js line 752 and
//   examples/jsm/exporters/GLTFExporter.js line 2884, and that extension defines point and spot lights in
//   candela and directional lights in lux. three's own sources never use the word, so this is the only
//   evidence chain the package offers.
//
// Light.power exists on the point and rect lights only, and it derives from intensity. Nothing here writes
// power or decay: they keep their physical defaults (decay 2, the inverse square law).

/** The panel's temperature span: 2700 to 8000 kelvin. */
export const KELVIN_RANGE: readonly [number, number] = [2700, 8000];

/** The panel's intensity span for the rect and point lights: 0 to 50 candela. */
export const CANDELA_RANGE: readonly [number, number] = [0, 50];

/** Unreal is centimetres, three is metres. */
const UNREAL_CM_PER_M = 100;

/** Krystek's approximation is published for 1000 K to 15000 K; the polynomials drift outside it. */
const PLANCKIAN_KELVIN_RANGE: readonly [number, number] = [1000, 15000];

/** The temperature the output is white balanced against, so 6500 K comes out exactly (1, 1, 1). */
const WHITE_KELVIN = 6500;

export function clamp(value: number, low: number, high: number): number {
  if (Number.isNaN(value)) return low;
  return value < low ? low : value > high ? high : value;
}

/**
 * The Planckian locus in linear BT.709 (the sRGB primaries with no transfer function), normalised to
 * luminance Y = 1. This is the same chain the Unreal original uses in FLinearColor::MakeFromColorTemperature:
 * Krystek's 1985 cubic approximation of the locus in CIE 1960 UCS, uv to xy, xyY at Y = 1 to XYZ, XYZ to
 * linear RGB. Values leave the sRGB gamut at both ends (1.93 in red at 2700 K), which is why kelvinToRgb
 * normalises before it returns.
 */
function planckianLinearRgb(kelvin: number): [number, number, number] {
  const t = clamp(kelvin, PLANCKIAN_KELVIN_RANGE[0], PLANCKIAN_KELVIN_RANGE[1]);
  const t2 = t * t;
  const u =
    (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t2) /
    (1 + 8.42420235e-4 * t + 7.08145163e-7 * t2);
  const v =
    (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t2) /
    (1 - 2.89741816e-5 * t + 1.61456053e-7 * t2);
  const denominator = 2 * u - 8 * v + 4;
  const x = (3 * u) / denominator;
  const y = (2 * v) / denominator;
  // xyY at Y = 1: X = x/y, Z = (1 - x - y)/y. The Y terms below are that 1, written out.
  const bigX = x / y;
  const bigZ = (1 - x - y) / y;
  return [
    3.2404542 * bigX - 1.5371385 - 0.4985314 * bigZ,
    -0.969266 * bigX + 1.8760108 + 0.041556 * bigZ,
    0.0556434 * bigX - 0.2040259 + 1.0572252 * bigZ,
  ];
}

const WHITE_LINEAR_RGB = planckianLinearRgb(WHITE_KELVIN);

/**
 * Colour temperature to a linear RGB tint for a light, 0 to 1 per channel.
 *
 * Two steps follow the locus above. First a white balance: divide by the 6500 K result, which makes 6500 K
 * exactly (1, 1, 1) and leaves every other temperature a ratio against it. Second a gamut fit: when the
 * largest channel is above 1 the whole triple is scaled down by it, which keeps the hue exact and only
 * moves the overall level, and a final clamp catches the tiny negatives the matrix produces far off the
 * locus. Both steps are needed because constant luminance puts the warm end well outside sRGB.
 *
 * The light's brightness comes from its own intensity in candela or lux, never from this tint.
 */
export function kelvinToRgb(kelvin: number): [number, number, number] {
  const raw = planckianLinearRgb(kelvin);
  const balanced: [number, number, number] = [
    raw[0] / WHITE_LINEAR_RGB[0],
    raw[1] / WHITE_LINEAR_RGB[1],
    raw[2] / WHITE_LINEAR_RGB[2],
  ];
  const peak = Math.max(balanced[0], balanced[1], balanced[2]);
  const scale = peak > 1 ? 1 / peak : 1;
  return [
    clamp(balanced[0] * scale, 0, 1),
    clamp(balanced[1] * scale, 0, 1),
    clamp(balanced[2] * scale, 0, 1),
  ];
}

/**
 * Luminous intensity to luminance for a rect area light: L = I / A. Unreal states a rect light in candela
 * and three.js states it in nits, so every rect light crosses this on the way in. 25 cd on a 4 m by 4 m
 * panel is 1.5625 nits.
 */
export function candelaToNits(candela: number, widthM: number, heightM: number): number {
  const area = widthM * heightM;
  if (!(area > 0)) {
    throw new RangeError(`candelaToNits needs a positive area, got ${widthM} by ${heightM}`);
  }
  return candela / area;
}

/**
 * Unreal centimetres, Z up, left handed, to three metres, Y up, right handed.
 *
 * The mapping is (x, y, z) to (x, z, y) with a divide by 100, derived from the level's own export rather
 * than assumed: see tests/unit/lighting-units.test.ts, which pins it against the eight point lights and the
 * sun as level-main.glb carries them. Swapping two axes flips the handedness once, which is exactly what
 * left handed to right handed needs.
 */
export function unrealToThreePosition(cm: [number, number, number]): [number, number, number] {
  return [cm[0] / UNREAL_CM_PER_M, cm[2] / UNREAL_CM_PER_M, cm[1] / UNREAL_CM_PER_M];
}

/**
 * The same axis change for a direction, which carries no scale, followed by a normalise so the result is a
 * unit vector whatever the caller passed. A zero vector is not a direction and throws rather than returning
 * something that would silently orient a light at random.
 */
export function unrealToThreeDirection(forward: [number, number, number]): [number, number, number] {
  const mapped: [number, number, number] = [forward[0], forward[2], forward[1]];
  const length = Math.hypot(mapped[0], mapped[1], mapped[2]);
  if (!(length > 0)) {
    throw new RangeError(`unrealToThreeDirection needs a non-zero vector, got ${forward.join(', ')}`);
  }
  return [mapped[0] / length, mapped[1] / length, mapped[2] / length];
}
