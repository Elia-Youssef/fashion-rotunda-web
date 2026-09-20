// Goal G3.3: the showroom colour grade. Pure, typed arrays only, no three.js, so the
// lookup table, its monotonicity and its identity round-trip are testable in node.
//
// The grade applies in display space after AgX tone mapping and sRGB conversion:
// 1. A gentle S-curve enhancing midtone contrast.
// 2. A subtle warm lift in the shadows (slight red and green boost, zero at highlight).
// 3. Monotonic per channel so gradients never reverse or band.
// 4. Clamped to [0, 1] without hard clipping.

export const LUT_SIZE = 32;

/**
 * Creates an identity 3D LUT of RGB triplets with size^3 cells.
 * Red coordinate increments fastest, followed by green, then blue.
 * Every cell's stored color equals its own normalized [0, 1] grid coordinate.
 */
export function identityLut(size: number): Float32Array {
  const cells = size * size * size;
  const table = new Float32Array(cells * 3);
  const step = size > 1 ? 1 / (size - 1) : 0;
  let offset = 0;

  for (let ib = 0; ib < size; ib += 1) {
    const b = ib * step;
    for (let ig = 0; ig < size; ig += 1) {
      const g = ig * step;
      for (let ir = 0; ir < size; ir += 1) {
        const r = ir * step;
        table[offset] = r;
        table[offset + 1] = g;
        table[offset + 2] = b;
        offset += 3;
      }
    }
  }

  return table;
}

/** Gentle S-curve: mix linear with smooth cubic polynomial to lift contrast smoothly. */
function sCurve(x: number): number {
  const contrastFactor = 0.2;
  const cubic = x * x * (3 - 2 * x);
  return (1 - contrastFactor) * x + contrastFactor * cubic;
}

/**
 * The showroom's grade: gentle S-curve on luminance, slight warm lift in shadows,
 * saturation preserved, strictly monotonic per channel, never clipping below 0 or above 1.
 */
export function gradeLut(size: number): Float32Array {
  const cells = size * size * size;
  const table = new Float32Array(cells * 3);
  const step = size > 1 ? 1 / (size - 1) : 0;
  let offset = 0;

  for (let ib = 0; ib < size; ib += 1) {
    const b = ib * step;
    for (let ig = 0; ig < size; ig += 1) {
      const g = ig * step;
      for (let ir = 0; ir < size; ir += 1) {
        const r = ir * step;

        // Base gentle S-curve per channel preserves hue and saturation.
        const sr = sCurve(r);
        const sg = sCurve(g);
        const sb = sCurve(b);

        // Subtle warm lift in the deep shadows, decaying quadratically to zero in midtones.
        // Derivative of lift is small (-0.03 max) so total derivative remains strictly positive (> 0.7).
        const warmR = 0.015 * (1 - r) * (1 - r);
        const warmG = 0.008 * (1 - g) * (1 - g);

        const outR = Math.min(1, Math.max(0, sr + warmR));
        const outG = Math.min(1, Math.max(0, sg + warmG));
        const outB = Math.min(1, Math.max(0, sb));

        table[offset] = outR;
        table[offset + 1] = outG;
        table[offset + 2] = outB;
        offset += 3;
      }
    }
  }

  return table;
}

/**
 * Nearest-cell sampler, for unit tests.
 * Resolves normalized [0, 1] coordinates to the nearest discrete LUT cell.
 */
export function sampleLut(
  table: Float32Array,
  size: number,
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const maxIdx = size - 1;
  const ir = Math.min(maxIdx, Math.max(0, Math.round(r * maxIdx)));
  const ig = Math.min(maxIdx, Math.max(0, Math.round(g * maxIdx)));
  const ib = Math.min(maxIdx, Math.max(0, Math.round(b * maxIdx)));
  const offset = (ir + ig * size + ib * size * size) * 3;

  return [table[offset]!, table[offset + 1]!, table[offset + 2]!];
}
