// Goals G2.3 and G2.5: the post chain's decision table. Pure, no three.js, so the tier-to-features
// mapping is testable in node against TIERS, the one source of every number.
//
// The chain follows this and nothing else: it never reads the tier table itself.

import type { TierSettings } from '../tiers/table';

export interface PostSettings {
  ao: boolean;
  /** True whenever ao is true; every AO variant in the tier table runs GTAO at half resolution. */
  aoHalfResolution: boolean;
  traa: boolean;
  msaa: boolean;
  /** MSAA sample count; 4 when msaa is on, 0 otherwise. */
  samples: number;
}

/**
 * The rows this module owns, read off the tier: antialiasing 'msaa' means MSAA with 4 samples,
 * 'traa' means TRAA and no MSAA (TRAANode.js line 18: "MSAA must be disabled when TRAA is in
 * use"); ao 'gtao-half-desktop-only' means the AO exists on desktop only, 'gtao-half' means every
 * device. Touch means no pointer, which the caller reads from matchMedia.
 */
export function postSettingsFor(tier: TierSettings, isTouch: boolean): PostSettings {
  const aoEnabled = tier.ao === 'gtao-half' || (tier.ao === 'gtao-half-desktop-only' && !isTouch);
  const traa = tier.antialiasing === 'traa';
  const msaa = tier.antialiasing === 'msaa';
  return {
    ao: aoEnabled,
    aoHalfResolution: aoEnabled,
    traa,
    msaa,
    samples: msaa ? 4 : 0,
  };
}
