import { describe, expect, it } from 'vitest';
import { decideTier, isIntegratedGpu, tierOverrideFromUrl } from '../../src/tiers/decide';
import type { TierInput } from '../../src/tiers/decide';

// A discrete desktop GPU on WebGPU with no benchmark yet; the expected high-tier baseline.
function input(overrides: Partial<TierInput>): TierInput {
  return {
    backend: 'webgpu',
    gpuName: 'NVIDIA GeForce RTX 4080',
    deviceMemoryGB: 32,
    isTouch: false,
    viewportWidth: 1920,
    benchmarkP95Ms: null,
    ...overrides,
  };
}

describe('isIntegratedGpu', () => {
  it.each([
    ['Intel(R) UHD Graphics 620'],
    ['Intel(R) Iris(R) Xe Graphics'],
    ['AMD Radeon Graphics'],
    ['Apple M1'],
    ['Apple M3 Pro'],
    ['Mali-G78'],
    ['Adreno (TM) 740'],
    ['SwiftShader'],
    ['llvmpipe (LLVM 15.0.7, 256 bits)'],
    ['Basic Render Driver'],
  ])('classifies %s as integrated', (gpuName) => {
    expect(isIntegratedGpu(gpuName)).toBe(true);
  });

  it.each([
    ['NVIDIA GeForce RTX 4080'],
    ['AMD Radeon RX 7900 XTX'],
    // "Radeon Graphics" followed by a model number is a named part, not the bare integrated label.
    ['AMD Radeon Graphics W6600'],
  ])('classifies %s as discrete', (gpuName) => {
    expect(isIntegratedGpu(gpuName)).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(isIntegratedGpu('intel(r) uhd graphics')).toBe(true);
    expect(isIntegratedGpu('APPLE M2')).toBe(true);
  });
});

describe('decideTier', () => {
  it('gives a discrete GPU on webgpu the high tier when no benchmark ran yet', () => {
    expect(decideTier(input({}))).toBe('high');
  });

  it('gives a discrete GPU on webgpu the high tier at exactly the 12 ms benchmark boundary', () => {
    expect(decideTier(input({ benchmarkP95Ms: 12 }))).toBe('high');
    expect(decideTier(input({ benchmarkP95Ms: 12.1 }))).toBe('mid');
  });

  it('drops a discrete GPU on webgpu to mid when the benchmark reads 14 ms', () => {
    expect(decideTier(input({ benchmarkP95Ms: 14 }))).toBe('mid');
  });

  it('caps an integrated GPU on webgpu at mid', () => {
    expect(decideTier(input({ gpuName: 'Intel(R) UHD Graphics' }))).toBe('mid');
    expect(decideTier(input({ gpuName: 'Apple M2', benchmarkP95Ms: 5 }))).toBe('mid');
  });

  it('caps everything on the webgl2 backend at mid, even a fast discrete GPU', () => {
    expect(decideTier(input({ backend: 'webgl2' }))).toBe('mid');
    expect(decideTier(input({ backend: 'webgl2', benchmarkP95Ms: 5 }))).toBe('mid');
  });

  it('sends a touch device to base even with a discrete GPU', () => {
    expect(decideTier(input({ isTouch: true }))).toBe('base');
  });

  it('lowers the result one step when deviceMemoryGB is below 4', () => {
    // mid (integrated) -> base, high (discrete) -> mid, base (touch) stays base.
    expect(decideTier(input({ gpuName: 'Intel(R) UHD Graphics', deviceMemoryGB: 2 }))).toBe('base');
    expect(decideTier(input({ deviceMemoryGB: 2 }))).toBe('mid');
    expect(decideTier(input({ isTouch: true, deviceMemoryGB: 2 }))).toBe('base');
  });

  it('treats null deviceMemoryGB as no constraint', () => {
    expect(decideTier(input({ deviceMemoryGB: null }))).toBe('high');
  });

  it('treats exactly 4 GB as enough memory', () => {
    expect(decideTier(input({ gpuName: 'Intel(R) UHD Graphics', deviceMemoryGB: 4 }))).toBe('mid');
  });
});

describe('tierOverrideFromUrl', () => {
  it('reads the tier from the query string', () => {
    expect(tierOverrideFromUrl('?tier=high')).toBe('high');
    expect(tierOverrideFromUrl('?tier=base')).toBe('base');
    expect(tierOverrideFromUrl('?tier=mid&proof=1')).toBe('mid');
  });

  it('returns null for absent or unrecognized values', () => {
    expect(tierOverrideFromUrl('')).toBeNull();
    expect(tierOverrideFromUrl('?tier=ultra')).toBeNull();
    expect(tierOverrideFromUrl('?proof=1')).toBeNull();
  });
});
