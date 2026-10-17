// Per-device tier selection: touch, backend, GPU and benchmark, then the low-memory downgrade.

import { TIER_ORDER } from './table';
import type { TierName } from './table';

/**
 * The page's touch rule: a coarse primary pointer. A touch device always runs Base (decideTier), so the
 * lobby poster markup and the unsupported poster page choose the phone poster by this same query.
 */
export const TOUCH_POINTER_QUERY = '(pointer: coarse)';

/** Benchmark headroom gate for High; runtime frame budgets live in table.ts. */
const HIGH_TIER_MAX_BENCHMARK_P95_MS = 12;
/** Below this memory survey value, step down one row of table.ts. */
const MIN_DISCRETE_MEMORY_GB = 4;

export interface TierInput {
  backend: 'webgpu' | 'webgl2';
  gpuName: string;
  deviceMemoryGB: number | null;
  isTouch: boolean;
  viewportWidth: number;
  benchmarkP95Ms: number | null;
}

/** Substrings that name an integrated GPU, matched case-insensitively against the whole name. */
const INTEGRATED_MARKERS: readonly string[] = [
  'intel',
  'uhd',
  'iris',
  'mali',
  'adreno',
  'swiftshader',
  'llvmpipe',
  'basic render',
];

const RADEON_WITH_MODEL = /radeon graphics[^\d]*\d/;
const APPLE_SILICON = /apple m\d/;

export function isIntegratedGpu(gpuName: string): boolean {
  const name = gpuName.toLowerCase();
  for (const marker of INTEGRATED_MARKERS) {
    if (name.includes(marker)) {
      return true;
    }
  }
  // "Radeon Graphics" with nothing after it is the integrated AMD label; any digit later in
  // the name (610M, W6600) is a model number, which means a named, discrete part.
  if (name.includes('radeon graphics') && !RADEON_WITH_MODEL.test(name)) {
    return true;
  }
  // Apple silicon ("Apple M2", "Apple M3 Pro") counts as integrated for tier purposes.
  return APPLE_SILICON.test(name);
}

/**
 * The URL override is deliberately NOT applied here: the caller reads tierOverrideFromUrl and
 * only calls decideTier when there is no override, which keeps this function pure and testable.
 */
export function decideTier(input: TierInput): TierName {
  let tier: TierName;
  if (input.isTouch) {
    tier = 'base';
  } else if (input.backend === 'webgl2') {
    // The fallback backend never earns high, whatever the hardware survey says.
    tier = 'mid';
  } else if (isIntegratedGpu(input.gpuName)) {
    tier = 'mid';
  } else if (input.benchmarkP95Ms === null || input.benchmarkP95Ms <= HIGH_TIER_MAX_BENCHMARK_P95_MS) {
    // Discrete on WebGPU: trusted as high until the benchmark says otherwise (null means the
    // benchmark has not run yet).
    tier = 'high';
  } else {
    tier = 'mid';
  }
  if (input.deviceMemoryGB !== null && input.deviceMemoryGB < MIN_DISCRETE_MEMORY_GB) {
    tier = TIER_ORDER[Math.max(0, TIER_ORDER.indexOf(tier) - 1)];
  }
  return tier;
}

/** Returns the tier named by ?tier=base|mid|high, null for absent or unrecognized values. */
export function tierOverrideFromUrl(search: string): TierName | null {
  const value = new URLSearchParams(search).get('tier');
  if (value === 'base' || value === 'mid' || value === 'high') {
    return value;
  }
  return null;
}
