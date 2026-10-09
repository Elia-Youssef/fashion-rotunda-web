import { describe, expect, it } from 'vitest';
import { TIERS, TIER_ORDER } from '../../src/tiers/table';

// The agreed tier values pinned cell by cell: 13 settings x 3 tiers = 39 assertions. A tier change
// edits this test and src/tiers/table.ts together, never the table alone.
describe('TIERS table matches the agreed tier values', () => {
  it('pins pixelRatioCap', () => {
    expect(TIERS.base.pixelRatioCap).toBe(1.5);
    expect(TIERS.mid.pixelRatioCap).toBe(2);
    expect(TIERS.high.pixelRatioCap).toBe(2);
  });

  it('pins frameCapTouch', () => {
    expect(TIERS.base.frameCapTouch).toBe(30);
    expect(TIERS.mid.frameCapTouch).toBeNull();
    expect(TIERS.high.frameCapTouch).toBeNull();
  });

  it('pins frameBudgetMs', () => {
    expect(TIERS.base.frameBudgetMs).toBe(24);
    expect(TIERS.mid.frameBudgetMs).toBe(20);
    expect(TIERS.high.frameBudgetMs).toBe(16.7);
  });

  it('pins scalerSteps', () => {
    expect(TIERS.base.scalerSteps).toEqual([1, 0.85, 0.7, 0.55]);
    expect(TIERS.mid.scalerSteps).toEqual([1, 0.85, 0.7, 0.55]);
    expect(TIERS.high.scalerSteps).toEqual([1, 0.85, 0.7, 0.55]);
  });

  it('pins shadowMapSize', () => {
    expect(TIERS.base.shadowMapSize).toBe(1024);
    expect(TIERS.mid.shadowMapSize).toBe(2048);
    expect(TIERS.high.shadowMapSize).toBe(2048);
  });

  it('pins antialiasing', () => {
    expect(TIERS.base.antialiasing).toBe('msaa');
    expect(TIERS.mid.antialiasing).toBe('traa');
    expect(TIERS.high.antialiasing).toBe('traa');
  });

  it('pins ao', () => {
    expect(TIERS.base.ao).toBe('gtao-half-desktop-only');
    expect(TIERS.mid.ao).toBe('gtao-half');
    expect(TIERS.high.ao).toBe('gtao-half');
  });

  it('pins ssgi', () => {
    expect(TIERS.base.ssgi).toBe('off');
    expect(TIERS.mid.ssgi).toBe('off');
    expect(TIERS.high.ssgi).toBe('off');
  });

  it('pins ssr', () => {
    expect(TIERS.base.ssr).toBe(false);
    expect(TIERS.mid.ssr).toBe(false);
    expect(TIERS.high.ssr).toBe(true);
  });

  it('pins bloom', () => {
    expect(TIERS.base.bloom).toBe(false);
    expect(TIERS.mid.bloom).toBe(true);
    expect(TIERS.high.bloom).toBe(true);
  });

  it('pins lut', () => {
    expect(TIERS.base.lut).toBe(true);
    expect(TIERS.mid.lut).toBe(true);
    expect(TIERS.high.lut).toBe(true);
  });

  it('pins dof', () => {
    expect(TIERS.base.dof).toBe('off');
    expect(TIERS.mid.dof).toBe('off');
    expect(TIERS.high.dof).toBe('at-rest');
  });

  it('pins assetSet', () => {
    expect(TIERS.base.assetSet).toBe('half-on-touch');
    expect(TIERS.mid.assetSet).toBe('full');
    expect(TIERS.high.assetSet).toBe('full');
  });

  it('lists the three tiers in ascending order and nothing else', () => {
    expect(TIER_ORDER).toEqual(['base', 'mid', 'high']);
    expect(Object.keys(TIERS)).toEqual(['base', 'mid', 'high']);
  });
});
