import { describe, expect, it } from 'vitest';
import { ResolutionScaler } from '../../src/loop/scaler';
import type { ScalerOptions } from '../../src/loop/scaler';

const STEPS: readonly number[] = [1, 0.85, 0.7, 0.55];

// Budget 20 ms and discrete caller-supplied clocks; every test drives time by hand.
function makeScaler(overrides?: Partial<ScalerOptions>): ResolutionScaler {
  return new ResolutionScaler({ budgetMs: 20, steps: STEPS, ...overrides });
}

describe('ResolutionScaler', () => {
  it('stays at the first step while the p95 sits inside the budget', () => {
    const scaler = makeScaler();
    expect(scaler.update(10, 0)).toBe(1);
    expect(scaler.update(10, 60000)).toBe(1);
    expect(scaler.scale).toBe(1);
  });

  it('walks the down ladder one entry per downAfterMs of continuous overrun', () => {
    const scaler = makeScaler({ downAfterMs: 2000 });
    scaler.update(30, 0);
    expect(scaler.update(30, 1999)).toBe(1);
    expect(scaler.update(30, 2000)).toBe(0.85);
    expect(scaler.update(30, 3999)).toBe(0.85);
    expect(scaler.update(30, 4000)).toBe(0.7);
    expect(scaler.update(30, 6000)).toBe(0.55);
  });

  it('never steps below the last entry', () => {
    const scaler = makeScaler({ downAfterMs: 2000 });
    scaler.update(30, 0);
    scaler.update(30, 2000);
    scaler.update(30, 4000);
    scaler.update(30, 6000);
    expect(scaler.update(30, 8000)).toBe(0.55);
    expect(scaler.update(30, 100000)).toBe(0.55);
    expect(scaler.scale).toBe(0.55);
  });

  it('restarts the down timer after each step', () => {
    const scaler = makeScaler({ downAfterMs: 2000 });
    scaler.update(30, 0);
    // The step at 2000 restarts the streak, so 2000 ms more must pass for the next one.
    expect(scaler.update(30, 2000)).toBe(0.85);
    expect(scaler.update(30, 3999)).toBe(0.85);
    expect(scaler.update(30, 4000)).toBe(0.7);
  });

  it('restarts the streak when the p95 crosses the budget', () => {
    const scaler = makeScaler({ downAfterMs: 2000 });
    scaler.update(30, 0);
    scaler.update(30, 1500);
    scaler.update(10, 1600); // one good sample ends the over streak
    scaler.update(30, 1700); // the over streak restarts from here
    expect(scaler.update(30, 3699)).toBe(1);
    expect(scaler.update(30, 3700)).toBe(0.85);
  });

  it('walks the up ladder one entry per upAfterMs and never above the first', () => {
    const scaler = makeScaler();
    scaler.update(30, 0);
    scaler.update(30, 2000);
    scaler.update(30, 4000);
    scaler.update(30, 6000); // at 0.55 now
    expect(scaler.update(10, 6000)).toBe(0.55); // under-streak starts
    expect(scaler.update(10, 10999)).toBe(0.55);
    expect(scaler.update(10, 11000)).toBe(0.7);
    expect(scaler.update(10, 16000)).toBe(0.85);
    expect(scaler.update(10, 21000)).toBe(1);
    expect(scaler.update(10, 26000)).toBe(1);
  });

  it('honours custom upAfterMs', () => {
    const scaler = makeScaler({ downAfterMs: 1000, upAfterMs: 1000 });
    scaler.update(30, 0);
    expect(scaler.update(30, 1000)).toBe(0.85);
    expect(scaler.update(10, 1000)).toBe(0.85); // under-streak starts at 1000
    expect(scaler.update(10, 1999)).toBe(0.85);
    expect(scaler.update(10, 2000)).toBe(1);
  });

  it('treats a p95 exactly at the budget as inside it, forever', () => {
    const scaler = makeScaler();
    expect(scaler.update(20, 0)).toBe(1);
    expect(scaler.update(20, 100000)).toBe(1);
    // From a lower entry, exactly-at-budget counts as inside and climbs back up.
    const lowered = makeScaler({ downAfterMs: 2000 });
    lowered.update(30, 0);
    lowered.update(30, 2000); // 0.85
    expect(lowered.update(20, 2000)).toBe(0.85);
    expect(lowered.update(20, 6999)).toBe(0.85);
    expect(lowered.update(20, 7000)).toBe(1);
  });

  it('reset returns to the first entry with a cleared streak', () => {
    const scaler = makeScaler({ downAfterMs: 2000 });
    scaler.update(30, 0);
    scaler.update(30, 2000);
    expect(scaler.scale).toBe(0.85);
    scaler.reset();
    expect(scaler.scale).toBe(1);
    // The next over-streak must run the full window again, not inherit the old timer.
    expect(scaler.update(30, 5000)).toBe(1);
    expect(scaler.update(30, 6999)).toBe(1);
    expect(scaler.update(30, 7000)).toBe(0.85);
  });

  it.each(STEPS)('adopts scale %s and resumes from that step in either direction', (scale) => {
    const index = STEPS.indexOf(scale);
    for (const over of [false, true]) {
      const scaler = makeScaler();
      const sample = over ? 30 : 10;
      const windowMs = over ? 2000 : 5000;
      scaler.update(sample, 0);
      scaler.setScale(scale);
      expect(scaler.scale).toBe(scale);
      // Even the same step must discard qualification accumulated before adoption.
      expect(scaler.update(sample, 60000)).toBe(scale);
      expect(scaler.update(sample, 60000 + windowMs - 1)).toBe(scale);
      const next = Math.max(0, Math.min(STEPS.length - 1, index + (over ? 1 : -1)));
      expect(scaler.update(sample, 60000 + windowMs)).toBe(STEPS[next]);
    }
  });

  it.each([0, 0.9, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects unconfigured scale %s without changing the step or streak',
    (scale) => {
      const scaler = makeScaler();
      scaler.update(30, 0);
      scaler.update(30, 2000);
      expect(() => scaler.setScale(scale)).toThrow(RangeError);
      expect(scaler.scale).toBe(STEPS[1]);
      expect(scaler.update(30, 4000)).toBe(STEPS[2]);
    },
  );
});
