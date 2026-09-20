import { describe, expect, it } from 'vitest';
import { postSettingsFor } from '../../src/post/settings';
import type { Backend } from '../../src/post/settings';
import { TIERS, TIER_ORDER } from '../../src/tiers/table';
import type { TierSettings } from '../../src/tiers/table';

// The decision the chain follows, pinned against TIERS itself so the table stays the one source:
// every tier x touch x backend combination, plus the invariants the chain relies on.
// The rows come from Appendix D: antialiasing 'msaa' on base, 'traa' on mid and high; ao
// 'gtao-half-desktop-only' on base, 'gtao-half' on mid and high; ssgi and ssr on high for webgpu
// only, and never on webgl2.

interface Row {
  tier: TierSettings;
  isTouch: boolean;
  backend: Backend;
  ao: boolean;
  aoHalfResolution: boolean;
  traa: boolean;
  msaa: boolean;
  samples: number;
  ssgi: 'off' | 'half-moving-full-at-rest';
  ssr: boolean;
}

const BACKENDS: readonly Backend[] = ['webgpu', 'webgl2'];

describe('postSettingsFor pinned against TIERS', () => {
  const rows: Row[] = [
    // base is MSAA; its AO is desktop only; SSGI and SSR are off on both backends.
    {
      tier: TIERS.base,
      isTouch: true,
      backend: 'webgpu',
      ao: false,
      aoHalfResolution: false,
      traa: false,
      msaa: true,
      samples: 4,
      ssgi: 'off',
      ssr: false,
    },
    {
      tier: TIERS.base,
      isTouch: false,
      backend: 'webgpu',
      ao: true,
      aoHalfResolution: true,
      traa: false,
      msaa: true,
      samples: 4,
      ssgi: 'off',
      ssr: false,
    },
    {
      tier: TIERS.base,
      isTouch: true,
      backend: 'webgl2',
      ao: false,
      aoHalfResolution: false,
      traa: false,
      msaa: true,
      samples: 4,
      ssgi: 'off',
      ssr: false,
    },
    {
      tier: TIERS.base,
      isTouch: false,
      backend: 'webgl2',
      ao: true,
      aoHalfResolution: true,
      traa: false,
      msaa: true,
      samples: 4,
      ssgi: 'off',
      ssr: false,
    },
    // mid carries AO on every device and antialiases with TRAA; SSGI and SSR off.
    {
      tier: TIERS.mid,
      isTouch: true,
      backend: 'webgpu',
      ao: true,
      aoHalfResolution: true,
      traa: true,
      msaa: false,
      samples: 0,
      ssgi: 'off',
      ssr: false,
    },
    {
      tier: TIERS.mid,
      isTouch: false,
      backend: 'webgpu',
      ao: true,
      aoHalfResolution: true,
      traa: true,
      msaa: false,
      samples: 0,
      ssgi: 'off',
      ssr: false,
    },
    {
      tier: TIERS.mid,
      isTouch: true,
      backend: 'webgl2',
      ao: true,
      aoHalfResolution: true,
      traa: true,
      msaa: false,
      samples: 0,
      ssgi: 'off',
      ssr: false,
    },
    {
      tier: TIERS.mid,
      isTouch: false,
      backend: 'webgl2',
      ao: true,
      aoHalfResolution: true,
      traa: true,
      msaa: false,
      samples: 0,
      ssgi: 'off',
      ssr: false,
    },
    // high carries AO, TRAA, and SSGI/SSR on WebGPU only; WebGL 2 turns SSGI and SSR off.
    {
      tier: TIERS.high,
      isTouch: true,
      backend: 'webgpu',
      ao: true,
      aoHalfResolution: true,
      traa: true,
      msaa: false,
      samples: 0,
      ssgi: 'half-moving-full-at-rest',
      ssr: true,
    },
    {
      tier: TIERS.high,
      isTouch: false,
      backend: 'webgpu',
      ao: true,
      aoHalfResolution: true,
      traa: true,
      msaa: false,
      samples: 0,
      ssgi: 'half-moving-full-at-rest',
      ssr: true,
    },
    {
      tier: TIERS.high,
      isTouch: true,
      backend: 'webgl2',
      ao: true,
      aoHalfResolution: true,
      traa: true,
      msaa: false,
      samples: 0,
      ssgi: 'off',
      ssr: false,
    },
    {
      tier: TIERS.high,
      isTouch: false,
      backend: 'webgl2',
      ao: true,
      aoHalfResolution: true,
      traa: true,
      msaa: false,
      samples: 0,
      ssgi: 'off',
      ssr: false,
    },
  ];

  it('maps every tier, touch and backend combination', () => {
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(postSettingsFor(row.tier, row.isTouch, row.backend)).toEqual({
        ao: row.ao,
        aoHalfResolution: row.aoHalfResolution,
        traa: row.traa,
        msaa: row.msaa,
        samples: row.samples,
        ssgi: row.ssgi,
        ssr: row.ssr,
      });
    }
  });

  it('never turns MSAA and TRAA on together, for any tier or device', () => {
    for (const name of TIER_ORDER) {
      for (const isTouch of [false, true]) {
        for (const backend of BACKENDS) {
          const settings = postSettingsFor(TIERS[name], isTouch, backend);
          expect(settings.msaa && settings.traa, `${name} touch=${isTouch} ${backend}`).toBe(false);
        }
      }
    }
  });

  it('runs the AO at half resolution whenever the AO is on', () => {
    for (const name of TIER_ORDER) {
      for (const isTouch of [false, true]) {
        for (const backend of BACKENDS) {
          const settings = postSettingsFor(TIERS[name], isTouch, backend);
          expect(settings.aoHalfResolution, `${name} touch=${isTouch} ${backend}`).toBe(settings.ao);
        }
      }
    }
  });

  it('carries samples only with MSAA', () => {
    for (const name of TIER_ORDER) {
      for (const isTouch of [false, true]) {
        for (const backend of BACKENDS) {
          const settings = postSettingsFor(TIERS[name], isTouch, backend);
          expect(settings.samples, `${name} touch=${isTouch} ${backend}`).toBe(
            settings.msaa ? 4 : 0,
          );
        }
      }
    }
  });

  it('forces SSGI and SSR off on webgl2 for all tiers', () => {
    for (const name of TIER_ORDER) {
      for (const isTouch of [false, true]) {
        const settings = postSettingsFor(TIERS[name], isTouch, 'webgl2');
        expect(settings.ssgi, `${name} touch=${isTouch} webgl2 ssgi`).toBe('off');
        expect(settings.ssr, `${name} touch=${isTouch} webgl2 ssr`).toBe(false);
      }
    }
  });

  /**
   * The chain's `?post=gi`, `?post=ssr` and `?post=max` slices read ssgi and ssr back off this
   * result rather than off the tier table, so the two have to agree row for row: a slice that
   * consulted the backend on its own would turn SSGI on for a tier whose row says 'off'.
   */
  it('mirrors the tier row verbatim on webgpu and blanks it on webgl2', () => {
    for (const name of TIER_ORDER) {
      for (const isTouch of [false, true]) {
        const onWebGPU = postSettingsFor(TIERS[name], isTouch, 'webgpu');
        expect(onWebGPU.ssgi, `${name} touch=${isTouch} webgpu ssgi`).toBe(TIERS[name].ssgi);
        expect(onWebGPU.ssr, `${name} touch=${isTouch} webgpu ssr`).toBe(TIERS[name].ssr);
        const onWebGL2 = postSettingsFor(TIERS[name], isTouch, 'webgl2');
        expect(onWebGL2.ssgi, `${name} touch=${isTouch} webgl2 ssgi`).toBe('off');
        expect(onWebGL2.ssr, `${name} touch=${isTouch} webgl2 ssr`).toBe(false);
      }
    }
  });

  it('enables SSGI and SSR on webgpu for the high tier only', () => {
    for (const name of TIER_ORDER) {
      for (const isTouch of [false, true]) {
        const settings = postSettingsFor(TIERS[name], isTouch, 'webgpu');
        if (name === 'high') {
          expect(settings.ssgi, `${name} touch=${isTouch} webgpu ssgi`).toBe(
            'half-moving-full-at-rest',
          );
          expect(settings.ssr, `${name} touch=${isTouch} webgpu ssr`).toBe(true);
        } else {
          expect(settings.ssgi, `${name} touch=${isTouch} webgpu ssgi`).toBe('off');
          expect(settings.ssr, `${name} touch=${isTouch} webgpu ssr`).toBe(false);
        }
      }
    }
  });
});

