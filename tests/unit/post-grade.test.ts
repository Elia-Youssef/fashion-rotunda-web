import { describe, expect, it } from 'vitest';
import { LUT_SIZE, gradeLut, identityLut } from '../../src/post/grade';

describe('post grade LUT', () => {
  it('exposes LUT_SIZE as 32', () => {
    expect(LUT_SIZE).toBe(32);
  });

  describe('identityLut', () => {
    it('allocates the exact buffer length for RGB triplets', () => {
      const lut = identityLut(LUT_SIZE);
      expect(lut).toHaveLength(LUT_SIZE * LUT_SIZE * LUT_SIZE * 3);
    });

    it('sets every cell to its own normalized coordinate with r fastest', () => {
      const size = 8;
      const lut = identityLut(size);
      const step = 1 / (size - 1);

      let offset = 0;
      for (let ib = 0; ib < size; ib += 1) {
        for (let ig = 0; ig < size; ig += 1) {
          for (let ir = 0; ir < size; ir += 1) {
            expect(lut[offset]).toBeCloseTo(ir * step, 6);
            expect(lut[offset + 1]).toBeCloseTo(ig * step, 6);
            expect(lut[offset + 2]).toBeCloseTo(ib * step, 6);
            offset += 3;
          }
        }
      }
    });

    it('returns one zeroed cell when size is 1', () => {
      const lut = identityLut(1);
      expect(lut).toHaveLength(3);
      expect(lut[0]).toBe(0);
      expect(lut[1]).toBe(0);
      expect(lut[2]).toBe(0);
    });
  });

  describe('gradeLut', () => {
    const cell = (lut: Float32Array, r: number, g: number, b: number): [number, number, number] => {
      const offset = (r + g * LUT_SIZE + b * LUT_SIZE * LUT_SIZE) * 3;
      return [lut[offset]!, lut[offset + 1]!, lut[offset + 2]!];
    };

    it('allocates the exact buffer length for RGB triplets', () => {
      const lut = gradeLut(LUT_SIZE);
      expect(lut).toHaveLength(LUT_SIZE * LUT_SIZE * LUT_SIZE * 3);
    });

    it('keeps all values strictly within [0, 1]', () => {
      const lut = gradeLut(LUT_SIZE);
      for (let i = 0; i < lut.length; i += 1) {
        const val = lut[i]!;
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(1);
      }
    });

    it('keeps black within 0.02 of pure black', () => {
      const lut = gradeLut(LUT_SIZE);
      const [r, g, b] = cell(lut, 0, 0, 0);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(0.02);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(0.02);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(0.02);
    });

    it('keeps white within 0.02 of pure white', () => {
      const lut = gradeLut(LUT_SIZE);
      const [r, g, b] = cell(lut, LUT_SIZE - 1, LUT_SIZE - 1, LUT_SIZE - 1);
      expect(r).toBeGreaterThanOrEqual(0.98);
      expect(r).toBeLessThanOrEqual(1.0);
      expect(g).toBeGreaterThanOrEqual(0.98);
      expect(g).toBeLessThanOrEqual(1.0);
      expect(b).toBeGreaterThanOrEqual(0.98);
      expect(b).toBeLessThanOrEqual(1.0);
    });

    it('is strictly monotonic per channel along red, green, and blue axes', () => {
      const size = LUT_SIZE;
      const lut = gradeLut(size);

      // Red axis monotonicity: for every (ig, ib), r increases with ir
      for (let ib = 0; ib < size; ib += 1) {
        for (let ig = 0; ig < size; ig += 1) {
          let prevR = -1;
          for (let ir = 0; ir < size; ir += 1) {
            const offset = (ir + ig * size + ib * size * size) * 3;
            const currentR = lut[offset]!;
            expect(currentR).toBeGreaterThan(prevR);
            prevR = currentR;
          }
        }
      }

      // Green axis monotonicity: for every (ir, ib), g increases with ig
      for (let ib = 0; ib < size; ib += 1) {
        for (let ir = 0; ir < size; ir += 1) {
          let prevG = -1;
          for (let ig = 0; ig < size; ig += 1) {
            const offset = (ir + ig * size + ib * size * size) * 3;
            const currentG = lut[offset + 1]!;
            expect(currentG).toBeGreaterThan(prevG);
            prevG = currentG;
          }
        }
      }

      // Blue axis monotonicity: for every (ir, ig), b increases with ib
      for (let ig = 0; ig < size; ig += 1) {
        for (let ir = 0; ir < size; ir += 1) {
          let prevB = -1;
          for (let ib = 0; ib < size; ib += 1) {
            const offset = (ir + ig * size + ib * size * size) * 3;
            const currentB = lut[offset + 2]!;
            expect(currentB).toBeGreaterThan(prevB);
            prevB = currentB;
          }
        }
      }
    });

    it('lifts warm tones in shadow values relative to blue', () => {
      const lut = gradeLut(LUT_SIZE);
      // Read a deep shadow neutral grid cell.
      const [r, g, b] = cell(lut, 2, 2, 2);
      expect(r).toBeGreaterThan(b);
      expect(g).toBeGreaterThan(b);
    });

    it('returns the designed shadow-lift cell when size is 1', () => {
      const lut = gradeLut(1);
      expect(lut).toHaveLength(3);
      expect(lut[0]).toBeCloseTo(0.015, 6);
      expect(lut[1]).toBeCloseTo(0.008, 6);
      expect(lut[2]).toBe(0);
    });

    it('darkens lower midtones and brightens upper midtones', () => {
      const lut = gradeLut(LUT_SIZE);
      const step = 1 / (LUT_SIZE - 1);
      const low = 8 * step;
      const high = 24 * step;

      const lowCell = cell(lut, 8, 8, 8);
      expect(lowCell[0]).toBeLessThan(low);
      expect(lowCell[1]).toBeLessThan(low);
      expect(lowCell[2]).toBeLessThan(low);

      const highCell = cell(lut, 24, 24, 24);
      expect(highCell[0]).toBeGreaterThan(high);
      expect(highCell[1]).toBeGreaterThan(high);
      expect(highCell[2]).toBeGreaterThan(high);
    });

    it('matches the shipped grade values at representative cells', () => {
      const lut = gradeLut(LUT_SIZE);
      const neutral = (i: number): [number, number, number] =>
        cell(lut, i, i, i);

      // The shipped look: per channel an 80/20 mix of linear and the
      // smoothstep cubic, plus warm lifts of 0.015 red and 0.008 green that
      // decay quadratically to zero at the highlight end. Coefficient drift
      // moves these cells, so a deliberate look change updates them.
      const pinned: Array<[number, number, number, number]> = [
        [0, 0.015, 0.008, 0],
        [8, 0.247792454097, 0.243939176261, 0.239535430163],
        [16, 0.521252223826, 0.519613306032, 0.517740257125],
        [24, 0.794131952603, 0.793775032728, 0.793367124299],
        [31, 1, 1, 1],
      ];
      for (const [i, r, g, b] of pinned) {
        const sampled = neutral(i);
        expect(sampled[0]).toBeCloseTo(r, 6);
        expect(sampled[1]).toBeCloseTo(g, 6);
        expect(sampled[2]).toBeCloseTo(b, 6);
      }

      // The warm lift reaches the red and green slots from any channel's
      // shadows, and the blue channel never takes a lift.
      const primaryRed = cell(lut, LUT_SIZE - 1, 0, 0);
      expect(primaryRed[0]).toBeCloseTo(1, 6);
      expect(primaryRed[1]).toBeCloseTo(0.008, 6);
      expect(primaryRed[2]).toBe(0);

      const primaryGreen = cell(lut, 0, LUT_SIZE - 1, 0);
      expect(primaryGreen[0]).toBeCloseTo(0.015, 6);
      expect(primaryGreen[1]).toBeCloseTo(1, 6);
      expect(primaryGreen[2]).toBe(0);

      const primaryBlue = cell(lut, 0, 0, LUT_SIZE - 1);
      expect(primaryBlue[0]).toBeCloseTo(0.015, 6);
      expect(primaryBlue[1]).toBeCloseTo(0.008, 6);
      expect(primaryBlue[2]).toBeCloseTo(1, 6);
    });
  });
});
