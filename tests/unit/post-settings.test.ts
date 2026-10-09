import { describe, expect, it } from 'vitest';
import { postSettingsFor, settingsForLevel } from '../../src/post/settings';
import type { Backend } from '../../src/post/settings';
import { TIERS, TIER_ORDER } from '../../src/tiers/table';
import type { TierSettings } from '../../src/tiers/table';

// The decision the chain follows, pinned against TIERS itself so the table stays the one source:
// every tier x touch x backend combination, plus the invariants the chain relies on.
// The agreed tier rows: antialiasing 'msaa' on base, 'traa' on mid and high; ao
// 'gtao-half-desktop-only' on base, 'gtao-half' on mid and high; SSR on high WebGPU while raw SSGI
// remains available only through the explicit ?post=gi diagnostic slice. Neither compute effect
// runs on WebGL 2.

interface Row {
  tier: TierSettings;
  isTouch: boolean;
  backend: Backend;
  ao: boolean;
  aoHalfResolution: boolean;
  traa: boolean;
  msaa: boolean;
  samples: number;
  ssgi: 'off' | 'full-with-half-fallback';
  ssr: boolean;
  bloom: boolean;
  lut: boolean;
  vignette: boolean;
  dof: 'off' | 'at-rest';
}

const BACKENDS: readonly Backend[] = ['webgpu', 'webgl2'];

describe('postSettingsFor pinned against TIERS', () => {
  const rows: Row[] = [
    // base is MSAA; its AO is desktop only; SSGI and SSR are off on both backends; bloom off;
    // lut/vignette on.
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
      bloom: false,
      lut: true,
      vignette: true,
      dof: 'off',
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
      bloom: false,
      lut: true,
      vignette: true,
      dof: 'off',
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
      bloom: false,
      lut: true,
      vignette: true,
      dof: 'off',
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
      bloom: false,
      lut: true,
      vignette: true,
      dof: 'off',
    },
    // mid carries AO on every device, TRAA, bloom, lut, vignette; SSGI, SSR and dof off.
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
      bloom: true,
      lut: true,
      vignette: true,
      dof: 'off',
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
      bloom: true,
      lut: true,
      vignette: true,
      dof: 'off',
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
      bloom: true,
      lut: true,
      vignette: true,
      dof: 'off',
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
      bloom: true,
      lut: true,
      vignette: true,
      dof: 'off',
    },
    // High carries AO, TRAA, SSR and DoF on WebGPU; raw SSGI is off in the normal preset.
    {
      tier: TIERS.high,
      isTouch: true,
      backend: 'webgpu',
      ao: true,
      aoHalfResolution: true,
      traa: true,
      msaa: false,
      samples: 0,
      ssgi: 'off',
      ssr: true,
      bloom: true,
      lut: true,
      vignette: true,
      dof: 'at-rest',
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
      ssgi: 'off',
      ssr: true,
      bloom: true,
      lut: true,
      vignette: true,
      dof: 'at-rest',
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
      bloom: true,
      lut: true,
      vignette: true,
      dof: 'off',
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
      bloom: true,
      lut: true,
      vignette: true,
      dof: 'off',
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
        bloom: row.bloom,
        lut: row.lut,
        vignette: row.vignette,
        dof: row.dof,
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

  /** Normal settings follow the table; the explicit ?post=gi diagnostic overrides SSGI in chain.ts. */
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

  it('keeps raw SSGI off and enables SSR only on WebGPU High', () => {
    for (const name of TIER_ORDER) {
      for (const isTouch of [false, true]) {
        const settings = postSettingsFor(TIERS[name], isTouch, 'webgpu');
        if (name === 'high') {
          expect(settings.ssgi, `${name} touch=${isTouch} webgpu ssgi`).toBe('off');
          expect(settings.ssr, `${name} touch=${isTouch} webgpu ssr`).toBe(true);
        } else {
          expect(settings.ssgi, `${name} touch=${isTouch} webgpu ssgi`).toBe('off');
          expect(settings.ssr, `${name} touch=${isTouch} webgpu ssr`).toBe(false);
        }
      }
    }
  });

  it('enables bloom on mid and high on both backends and disables on base', () => {
    for (const name of TIER_ORDER) {
      for (const isTouch of [false, true]) {
        for (const backend of BACKENDS) {
          const settings = postSettingsFor(TIERS[name], isTouch, backend);
          const expectedBloom = name !== 'base';
          expect(settings.bloom, `${name} touch=${isTouch} ${backend} bloom`).toBe(expectedBloom);
        }
      }
    }
  });

  it('enables LUT and vignette on every tier across touch and backend', () => {
    for (const name of TIER_ORDER) {
      for (const isTouch of [false, true]) {
        for (const backend of BACKENDS) {
          const settings = postSettingsFor(TIERS[name], isTouch, backend);
          expect(settings.lut, `${name} touch=${isTouch} ${backend} lut`).toBe(true);
          expect(settings.vignette, `${name} touch=${isTouch} ${backend} vignette`).toBe(true);
          expect(settings.vignette).toBe(settings.lut);
        }
      }
    }
  });

  it('enables depth of field at rest on high on webgpu only and forces off on webgl2', () => {
    for (const name of TIER_ORDER) {
      for (const isTouch of [false, true]) {
        for (const backend of BACKENDS) {
          const settings = postSettingsFor(TIERS[name], isTouch, backend);
          if (name === 'high' && backend === 'webgpu') {
            expect(settings.dof, `${name} touch=${isTouch} ${backend} dof`).toBe('at-rest');
          } else {
            expect(settings.dof, `${name} touch=${isTouch} ${backend} dof`).toBe('off');
          }
        }
      }
    }
  });

  describe('settingsForLevel governor degradation', () => {
    it('preserves all features at full and ssgi-half', () => {
      const initial = postSettingsFor(TIERS.high, false, 'webgpu');
      expect(settingsForLevel(initial, 'full')).toEqual(initial);
      expect(settingsForLevel(initial, 'ssgi-half')).toEqual(initial);
    });

    it('disables ssgi at no-ssgi while retaining ssr, bloom, lut, vignette and dof', () => {
      const initial = postSettingsFor(TIERS.high, false, 'webgpu');
      const degraded = settingsForLevel(initial, 'no-ssgi');
      expect(degraded.ssgi).toBe('off');
      expect(degraded.ssr).toBe(true);
      expect(degraded.bloom).toBe(true);
      expect(degraded.lut).toBe(true);
      expect(degraded.vignette).toBe(true);
      expect(degraded.dof).toBe('at-rest');
    });

    it('disables ssgi and ssr at no-ssr while retaining bloom, lut, vignette and dof', () => {
      const initial = postSettingsFor(TIERS.high, false, 'webgpu');
      const degraded = settingsForLevel(initial, 'no-ssr');
      expect(degraded.ssgi).toBe('off');
      expect(degraded.ssr).toBe(false);
      expect(degraded.bloom).toBe(true);
      expect(degraded.lut).toBe(true);
      expect(degraded.vignette).toBe(true);
      expect(degraded.dof).toBe('at-rest');
    });

    it('at base level drops bloom and dof along with ssgi/ssr, but retains lut and vignette', () => {
      const initial = postSettingsFor(TIERS.high, false, 'webgpu');
      const degraded = settingsForLevel(initial, 'base');
      expect(degraded.ssgi).toBe('off');
      expect(degraded.ssr).toBe(false);
      expect(degraded.bloom).toBe(false);
      expect(degraded.dof).toBe('off');
      expect(degraded.lut).toBe(true);
      expect(degraded.vignette).toBe(true);
      expect(degraded.ao).toBe(initial.ao);
      expect(degraded.traa).toBe(initial.traa);
    });
  });
});
