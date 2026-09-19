import { describe, expect, it } from 'vitest';
import { postSettingsFor } from '../../src/post/settings';
import { TIERS, TIER_ORDER } from '../../src/tiers/table';
import type { TierSettings } from '../../src/tiers/table';

// The decision the chain follows, pinned against TIERS itself so the table stays the one source:
// every tier x touch combination, plus the invariants the chain relies on. The rows come from
// Appendix D: antialiasing 'msaa' on base, 'traa' on mid and high; ao 'gtao-half-desktop-only' on
// base, 'gtao-half' on mid and high.

interface Row {
  tier: TierSettings;
  isTouch: boolean;
  ao: boolean;
  aoHalfResolution: boolean;
  traa: boolean;
  msaa: boolean;
  samples: number;
}

describe('postSettingsFor pinned against TIERS', () => {
  const rows: Row[] = [
    // base is MSAA; its AO is the one row the device can switch off.
    {
      tier: TIERS.base,
      isTouch: true,
      ao: false,
      aoHalfResolution: false,
      traa: false,
      msaa: true,
      samples: 4,
    },
    {
      tier: TIERS.base,
      isTouch: false,
      ao: true,
      aoHalfResolution: true,
      traa: false,
      msaa: true,
      samples: 4,
    },
    // mid and high carry the AO on every device and always antialias with TRAA.
    {
      tier: TIERS.mid,
      isTouch: true,
      ao: true,
      aoHalfResolution: true,
      traa: true,
      msaa: false,
      samples: 0,
    },
    {
      tier: TIERS.mid,
      isTouch: false,
      ao: true,
      aoHalfResolution: true,
      traa: true,
      msaa: false,
      samples: 0,
    },
    {
      tier: TIERS.high,
      isTouch: true,
      ao: true,
      aoHalfResolution: true,
      traa: true,
      msaa: false,
      samples: 0,
    },
    {
      tier: TIERS.high,
      isTouch: false,
      ao: true,
      aoHalfResolution: true,
      traa: true,
      msaa: false,
      samples: 0,
    },
  ];

  it('maps every tier and touch combination', () => {
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(postSettingsFor(row.tier, row.isTouch)).toEqual({
        ao: row.ao,
        aoHalfResolution: row.aoHalfResolution,
        traa: row.traa,
        msaa: row.msaa,
        samples: row.samples,
      });
    }
  });

  it('never turns MSAA and TRAA on together, for any tier or device', () => {
    for (const name of TIER_ORDER) {
      for (const isTouch of [false, true]) {
        const settings = postSettingsFor(TIERS[name], isTouch);
        expect(settings.msaa && settings.traa, `${name} touch=${isTouch}`).toBe(false);
      }
    }
  });

  it('runs the AO at half resolution whenever the AO is on', () => {
    for (const name of TIER_ORDER) {
      for (const isTouch of [false, true]) {
        const settings = postSettingsFor(TIERS[name], isTouch);
        expect(settings.aoHalfResolution, `${name} touch=${isTouch}`).toBe(settings.ao);
      }
    }
  });

  it('carries samples only with MSAA', () => {
    for (const name of TIER_ORDER) {
      for (const isTouch of [false, true]) {
        const settings = postSettingsFor(TIERS[name], isTouch);
        expect(settings.samples, `${name} touch=${isTouch}`).toBe(settings.msaa ? 4 : 0);
      }
    }
  });
});
