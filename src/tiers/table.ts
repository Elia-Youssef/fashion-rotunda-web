// Goal G0.5: the quality tier table. This file is Appendix D of the project plan as code; the
// pinning test in tests/unit/tiers-table.test.ts keeps the two in lockstep.

export type TierName = 'base' | 'mid' | 'high';

export interface TierSettings {
  pixelRatioCap: number;
  /** Frames per second on touch devices only; desktop has no cap. */
  frameCapTouch: number | null;
  /** p95 of frame work, the render call duration with the cap wait excluded. */
  frameBudgetMs: number;
  scalerSteps: readonly number[];
  shadowMapSize: number;
  antialiasing: 'msaa' | 'traa';
  ao: 'gtao-half-desktop-only' | 'gtao-half';
  ssgi: 'off' | 'full-with-half-fallback';
  ssr: boolean;
  bloom: boolean;
  lut: boolean;
  dof: 'off' | 'at-rest';
  assetSet: 'half-on-touch' | 'full';
}

export const TIERS: Readonly<Record<TierName, TierSettings>> = {
  base: {
    pixelRatioCap: 1.5,
    frameCapTouch: 30,
    frameBudgetMs: 24,
    scalerSteps: [1.0, 0.85, 0.7, 0.55],
    shadowMapSize: 1024,
    antialiasing: 'msaa',
    ao: 'gtao-half-desktop-only',
    ssgi: 'off',
    ssr: false,
    bloom: false,
    lut: true,
    dof: 'off',
    assetSet: 'half-on-touch',
  },
  mid: {
    pixelRatioCap: 2,
    frameCapTouch: null,
    frameBudgetMs: 20,
    scalerSteps: [1.0, 0.85, 0.7, 0.55],
    shadowMapSize: 2048,
    antialiasing: 'traa',
    ao: 'gtao-half',
    ssgi: 'off',
    ssr: false,
    bloom: true,
    lut: true,
    dof: 'off',
    assetSet: 'full',
  },
  high: {
    pixelRatioCap: 2,
    frameCapTouch: null,
    frameBudgetMs: 16.7,
    scalerSteps: [1.0, 0.85, 0.7, 0.55],
    shadowMapSize: 2048,
    antialiasing: 'traa',
    ao: 'gtao-half',
    // The r186 raw SSGI output visibly grains walls and garments at client-sized viewports.
    // Keep its implementation available through ?post=gi while the normal High view stays clean.
    ssgi: 'off',
    ssr: true,
    bloom: true,
    lut: true,
    dof: 'at-rest',
    assetSet: 'full',
  },
};

/** Ascending quality order; index arithmetic in the decision and memory step-down uses this. */
export const TIER_ORDER: readonly TierName[] = ['base', 'mid', 'high'];
