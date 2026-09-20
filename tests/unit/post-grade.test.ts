import { describe, expect, it } from 'vitest';
import { LUT_SIZE, gradeLut, identityLut, sampleLut } from '../../src/post/grade';

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

    it('round-trips grid points through sampleLut with zero error', () => {
      const lut = identityLut(LUT_SIZE);
      const step = 1 / (LUT_SIZE - 1);

      for (let ib = 0; ib < LUT_SIZE; ib += 4) {
        for (let ig = 0; ig < LUT_SIZE; ig += 4) {
          for (let ir = 0; ir < LUT_SIZE; ir += 4) {
            const r = ir * step;
            const g = ig * step;
            const b = ib * step;
            const sampled = sampleLut(lut, LUT_SIZE, r, g, b);
            expect(sampled[0]).toBeCloseTo(r, 6);
            expect(sampled[1]).toBeCloseTo(g, 6);
            expect(sampled[2]).toBeCloseTo(b, 6);
          }
        }
      }
    });

    it('samples within nearest discrete cell tolerance across continuous domain', () => {
      const lut = identityLut(LUT_SIZE);
      const maxDiscreteError = 0.5 / (LUT_SIZE - 1);

      const testValues = [0.0, 0.05, 0.123, 0.333, 0.5, 0.777, 0.95, 1.0];
      for (const r of testValues) {
        for (const g of testValues) {
          for (const b of testValues) {
            const sampled = sampleLut(lut, LUT_SIZE, r, g, b);
            expect(Math.abs(sampled[0] - r)).toBeLessThanOrEqual(maxDiscreteError + 1e-6);
            expect(Math.abs(sampled[1] - g)).toBeLessThanOrEqual(maxDiscreteError + 1e-6);
            expect(Math.abs(sampled[2] - b)).toBeLessThanOrEqual(maxDiscreteError + 1e-6);
          }
        }
      }
    });
  });

  describe('gradeLut', () => {
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
      const [r, g, b] = sampleLut(lut, LUT_SIZE, 0, 0, 0);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(0.02);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(0.02);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(0.02);
    });

    it('keeps white within 0.02 of pure white', () => {
      const lut = gradeLut(LUT_SIZE);
      const [r, g, b] = sampleLut(lut, LUT_SIZE, 1, 1, 1);
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
      // Sample a deep shadow neutral coordinate
      const [r, g, b] = sampleLut(lut, LUT_SIZE, 0.05, 0.05, 0.05);
      expect(r).toBeGreaterThan(b);
      expect(g).toBeGreaterThan(b);
    });
  });
});
