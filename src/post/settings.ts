// Goals G2.3, G2.5, G3.1 and G3.2: the post chain's decision table. Pure, no three.js, so the
// tier-to-features mapping is testable in node against TIERS, the one source of every number.
//
// The chain follows this and nothing else: it never reads the tier table itself.

import type { TierSettings } from '../tiers/table';
import type { EnhancedLevel } from './governor';

export type Backend = 'webgpu' | 'webgl2';

export interface PostSettings {
  ao: boolean;
  /** True whenever ao is true; every AO variant in the tier table runs GTAO at half resolution. */
  aoHalfResolution: boolean;
  traa: boolean;
  msaa: boolean;
  /** MSAA sample count; 4 when msaa is on, 0 otherwise. */
  samples: number;
  /** 'off', or 'half-moving-full-at-rest' straight from the tier row; never on for webgl2. */
  ssgi: 'off' | 'half-moving-full-at-rest';
  ssr: boolean;
  bloom: boolean;
  lut: boolean;
  /** Rides with lut: the tier table groups Bloom, LUT and vignette. */
  vignette: boolean;
  /** 'off', or 'at-rest' straight from tier on webgpu; always 'off' on webgl2. */
  dof: 'off' | 'at-rest';
}

/**
 * The rows this module owns, read off the tier: antialiasing 'msaa' means MSAA with 4 samples,
 * 'traa' means TRAA and no MSAA (TRAANode.js line 18: "MSAA must be disabled when TRAA is in
 * use"); ao 'gtao-half-desktop-only' means the AO exists on desktop only, 'gtao-half' means every
 * device. Touch means no pointer, which the caller reads from matchMedia.
 *
 * SSGI and SSR are applied on webgpu directly from the tier row and forced off on webgl2, because
 * compute shaders have no WebGL fallback. Bloom, LUT and vignette run on both backends. Depth of
 * field runs on webgpu at rest and is forced off on webgl2.
 */
export function postSettingsFor(tier: TierSettings, isTouch: boolean, backend: Backend): PostSettings {
  const aoEnabled = tier.ao === 'gtao-half' || (tier.ao === 'gtao-half-desktop-only' && !isTouch);
  const traa = tier.antialiasing === 'traa';
  const msaa = tier.antialiasing === 'msaa';
  const isWebGPU = backend === 'webgpu';
  return {
    ao: aoEnabled,
    aoHalfResolution: aoEnabled,
    traa,
    msaa,
    samples: msaa ? 4 : 0,
    ssgi: isWebGPU ? tier.ssgi : 'off',
    ssr: isWebGPU ? tier.ssr : false,
    bloom: tier.bloom,
    lut: tier.lut,
    vignette: tier.lut,
    dof: isWebGPU ? tier.dof : 'off',
  };
}

/**
 * Derives the active settings for a given governor degradation level.
 * At 'base', compute features (SSGI, SSR) as well as bloom and depth of field are dropped,
 * while LUT and vignette are kept as they cost only a single lookup.
 */
export function settingsForLevel(settings: PostSettings, level: EnhancedLevel): PostSettings {
  if (level === 'full' || level === 'ssgi-half') {
    return settings;
  }
  if (level === 'no-ssgi') {
    return { ...settings, ssgi: 'off' };
  }
  if (level === 'no-ssr') {
    return { ...settings, ssgi: 'off', ssr: false };
  }
  return { ...settings, ssgi: 'off', ssr: false, bloom: false, dof: 'off' };
}
