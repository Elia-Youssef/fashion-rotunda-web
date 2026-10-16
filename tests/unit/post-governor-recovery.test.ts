import { describe, expect, it, vi } from 'vitest';
import {
  createGovernor,
  LEVEL_CHANGE_COOLDOWN_MS,
  RECOVERY_MAX_SAMPLE_GAP_MS,
  RECOVERY_QUALIFICATION_MS,
  RECOVERY_THRESHOLD_RATIO,
} from '../../src/post/governor';
import type { GovernorState } from '../../src/post/governor';
import {
  BUDGET_MS,
  COMFORTABLE_MS,
  degradedAtSsgiHalf,
  feed,
  span,
  THRESHOLD_MS,
} from '../support/post-governor';
import type { Sample } from '../support/post-governor';

// Recovery policy: qualification time, sample eligibility and the safe climb back up.

/** Inside the borderline band: above 80% of budget, at or under the budget itself. */
const BORDERLINE_MS = 15;

describe('post governor: recovery policy', () => {
  it('matrix 5: recovery accepts p95 exactly equal to 80% of the budget', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { gov, decidedAt } = degradedAtSsgiHalf();
    // Every sample at exactly the threshold float: nearest-rank p95 of the window is that same
    // float, and the comparison accepts equality. A comfortable window completes every 10
    // samples, so the run's 10,000th millisecond is first seen at a completion on sample 30.
    const exactly = BUDGET_MS * RECOVERY_THRESHOLD_RATIO;
    expect(exactly).toBe(THRESHOLD_MS);
    const samples = span(30, exactly, decidedAt + 1, 500);
    const level = feed(gov, samples);
    expect(level).toBe('full');
    expect(gov.diagnostics().events.at(-1)?.direction).toBe('up');
    consoleSpy.mockRestore();
  });

  it('matrix 6: recovery rejects p95 even slightly above 80% of the budget', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { gov, decidedAt } = degradedAtSsgiHalf();
    const slightlyOver = THRESHOLD_MS * (1 + 1e-9) + 1e-9;
    expect(slightlyOver).toBeGreaterThan(THRESHOLD_MS);
    expect(slightlyOver).toBeLessThanOrEqual(BUDGET_MS);
    feed(gov, span(50, slightlyOver, decidedAt + 1, 500));
    expect(gov.level).toBe('ssgi-half');
    // Borderline windows also reset the run, so nothing is quietly accruing.
    expect(gov.diagnostics(decidedAt + 25_000).recoveryElapsedMs).toBe(0);
    consoleSpy.mockRestore();
  });

  it('matrix 7: no recovery at 9999 ms of qualification', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { gov } = degradedAtSsgiHalf();
    // The run starts on the first post-change sample (t=201). Window one: gaps of 500 complete
    // at t=4701 (run 4500). Window two completes at t=9701 (run 9500). Window three ends the
    // run's 9999th millisecond exactly at t=10200 - which is also the cooldown's last allowed
    // instant - and must not recover.
    feed(gov, span(10, COMFORTABLE_MS, 201, 500));
    feed(gov, span(10, COMFORTABLE_MS, 5201, 500));
    const gaps = [55, 55, 55, 55, 55, 56, 56, 56, 56]; // sums to 499: 9701 + 499 = 10200
    let at = 9701;
    const thirdWindow: Sample[] = [];
    for (const gap of gaps) {
      at += gap;
      thirdWindow.push({ workMs: COMFORTABLE_MS, atMs: at, eligible: true });
    }
    expect(thirdWindow.at(-1)?.atMs).toBe(10_200);
    expect(feed(gov, thirdWindow)).toBe('ssgi-half');
    const diagnostics = gov.diagnostics(10_200);
    expect(diagnostics.cooldownRemainingMs).toBe(0);
    expect(diagnostics.recoveryElapsedMs).toBe(9_999);
    expect(diagnostics.recoveryElapsedMs).toBeLessThan(RECOVERY_QUALIFICATION_MS);
    consoleSpy.mockRestore();
  });

  it('matrix 8: recovery happens at or after 10,000 ms, on a complete eligible window', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { gov, decidedAt } = degradedAtSsgiHalf();
    // Comfortable windows complete at samples 10 (t=4701, run 4500), 20 (t=9701, run 9500,
    // cooldown still active until 10200) and 30 (t=14701, run 14500, cooldown expired):
    // exactly one step up, on the complete window.
    const level = feed(gov, span(30, COMFORTABLE_MS, decidedAt + 1, 500));
    expect(level).toBe('full');
    const events = gov.diagnostics().events;
    expect(events.length).toBe(2);
    expect(events[0].direction).toBe('down');
    expect(events[1].direction).toBe('up');
    expect(events[1].from).toBe('ssgi-half');
    expect(events[1].to).toBe('full');
    expect(events[1].atMs).toBe(14_701);
    consoleSpy.mockRestore();
  });

  it('recovers on the window completing exactly 10,000 ms into the run', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 2, patience: 2 });
    // Samples 400 ms apart: two over-budget windows decide at t=1600 (cooldown to
    // 11600), the eligible run restarts at t=2000, and windows complete every
    // second sample. The completion at t=12000 is the first past the cooldown and
    // holds exactly the required 10,000 ms: the boundary is inclusive there.
    feed(gov, span(4, 40, 400, 400));
    expect(gov.level).toBe('ssgi-half');
    for (let k = 0; k < 25; k += 1) {
      expect(gov.observe(COMFORTABLE_MS, 2000 + k * 400, true)).toBe('ssgi-half');
    }
    expect(gov.observe(COMFORTABLE_MS, 12_000, true)).toBe('full');
    consoleSpy.mockRestore();
  });

  it('matrix 9: recovery moves exactly one level', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 10, patience: 2 });
    // Four steps down land on base; one recovery may only climb to no-ssr. The walk down
    // decides every 20 samples (two windows of 500 ms spaced samples equal one cooldown).
    feed(gov, span(80, 40, 10, 500));
    expect(gov.level).toBe('base');
    feed(gov, span(30, COMFORTABLE_MS, 40_011, 500));
    expect(gov.level).toBe('no-ssr');
    consoleSpy.mockRestore();
  });

  it('matrix 10: recovery never moves above full', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { gov, decidedAt } = degradedAtSsgiHalf();
    feed(gov, span(30, COMFORTABLE_MS, decidedAt + 1, 500));
    expect(gov.level).toBe('full');
    // A further comfortably-under-budget decade changes nothing at the top of the ladder.
    feed(gov, span(40, COMFORTABLE_MS, 14_702, 500));
    expect(gov.level).toBe('full');
    expect(gov.diagnostics().events.length).toBe(2);
    consoleSpy.mockRestore();
  });

  it('matrix 12: a borderline window resets the recovery qualification', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { gov, decidedAt } = degradedAtSsgiHalf();
    feed(gov, span(10, COMFORTABLE_MS, decidedAt + 1, 500)); // run 4500 by t=4701
    // One borderline window: no level change, but the accumulated run is gone.
    feed(gov, span(10, BORDERLINE_MS, 4_801, 100));
    expect(gov.level).toBe('ssgi-half');
    expect(gov.diagnostics(5_801).recoveryElapsedMs).toBe(0);
    // The fresh run restarts at t=5801. Its first window completes at t=10301 holding 4500 ms,
    // where the original run would have read 10100 ms: the reset is why nothing recovers there.
    feed(gov, span(10, COMFORTABLE_MS, 5_801, 500));
    expect(gov.level).toBe('ssgi-half');
    expect(gov.diagnostics(10_301).recoveryElapsedMs).toBe(4_500);
    // The full fresh decade completes at t=20301 and recovers.
    feed(gov, span(20, COMFORTABLE_MS, 10_801, 500));
    expect(gov.level).toBe('full');
    consoleSpy.mockRestore();
  });

  it('matrix 13: an over-budget window resets the recovery qualification', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { gov, decidedAt } = degradedAtSsgiHalf();
    feed(gov, span(10, COMFORTABLE_MS, decidedAt + 1, 500)); // run 4500 by t=4701
    feed(gov, span(10, 40, 4_801, 100)); // over budget: run cleared, patience starts again
    expect(gov.diagnostics(5_801).recoveryElapsedMs).toBe(0);
    expect(gov.state.consecutiveOverBudget).toBe(1);
    // The restart at t=5801 holds 4500 ms at t=10301 (the original run would read 10100 ms).
    feed(gov, span(10, COMFORTABLE_MS, 5_801, 500));
    expect(gov.level).toBe('ssgi-half');
    feed(gov, span(20, COMFORTABLE_MS, 10_801, 500));
    expect(gov.level).toBe('full');
    consoleSpy.mockRestore();
  });

  it('matrix 14: one ineligible sample invalidates that recovery run', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { gov, decidedAt } = degradedAtSsgiHalf();
    feed(gov, span(10, COMFORTABLE_MS, decidedAt + 1, 500)); // run from 201, 4500 by 4701
    feed(gov, [{ workMs: COMFORTABLE_MS, atMs: 4_751, eligible: false }]);
    expect(gov.diagnostics(4_751).recoveryElapsedMs).toBe(0);
    // The run restarts at t=4801. At t=14301 it holds 9500 ms, where the original run would
    // have read 14100 ms: the ineligible sample is why nothing recovers there.
    feed(gov, span(20, COMFORTABLE_MS, 4_801, 500));
    expect(gov.level).toBe('ssgi-half');
    expect(gov.diagnostics(14_301).recoveryElapsedMs).toBe(9_500);
    feed(gov, span(10, COMFORTABLE_MS, 14_801, 500)); // fresh decade completes: one step up
    expect(gov.level).toBe('full');
    consoleSpy.mockRestore();
  });

  it('a defective observation leaves the next window recovery-eligible', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 40, patience: 2 });
    feed(gov, span(80, 40, 1000, 500)); // two over-budget windows: ssgi-half at t=40500
    feed(gov, span(10, COMFORTABLE_MS, 41_000, 500)); // partial comfortable window
    gov.observe(Number.NaN, 46_000, true); // defective reading: window, run and clock wiped
    // The cleared window is vacuously all-eligible and the clock did not advance.
    expect(gov.state.windowAllEligible).toBe(true);
    expect(gov.state.lastObservedAtMs).toBe(45_500);
    // The first fully post-defect window completes at t=66000 holding a 19,500 ms
    // run, past the t=50500 cooldown: nothing marks it ineligible, so this
    // completion itself recovers instead of delaying the decision by one window.
    feed(gov, span(40, COMFORTABLE_MS, 46_500, 500));
    expect(gov.level).toBe('full');
    consoleSpy.mockRestore();
  });

  it('a window that held an ineligible sample can never produce the recovery', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 40, patience: 2 });
    feed(gov, span(80, 40, 1000, 500)); // ssgi-half at t=40500, cooldown to 50500
    // The post-decision window opens on one ineligible sample and fills with
    // eligible ones; it completes at t=60500 holding a 19,000 ms run, but a
    // window is recovery evidence only when every one of its samples was.
    feed(gov, [{ workMs: COMFORTABLE_MS, atMs: 41_000, eligible: false }]);
    feed(gov, span(5, COMFORTABLE_MS, 41_500, 500));
    expect(gov.state.windowAllEligible).toBe(false);
    feed(gov, span(34, COMFORTABLE_MS, 44_000, 500));
    expect(gov.level).toBe('ssgi-half');
    // The next window starts fresh and all-eligible: it recovers normally.
    feed(gov, span(40, COMFORTABLE_MS, 61_000, 500));
    expect(gov.level).toBe('full');
    consoleSpy.mockRestore();
  });

  it(`matrix 15: a sample gap above ${RECOVERY_MAX_SAMPLE_GAP_MS} ms restarts the run, exactly 500 ms does not`, () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { gov, decidedAt } = degradedAtSsgiHalf();
    // All gaps 500 ms: the boundary is inclusive, recovery lands on the window at t=14701.
    feed(gov, span(30, COMFORTABLE_MS, decidedAt + 1, 500));
    expect(gov.level).toBe('full');

    const { gov: second, decidedAt: secondDecision } = degradedAtSsgiHalf();
    // Same stream, but the 20th sample arrives 501 ms after the 19th: the run restarts there,
    // so the next window completing at t=15202 holds a 5000 ms run instead of 14500 ms.
    feed(second, span(19, COMFORTABLE_MS, secondDecision + 1, 500));
    feed(second, [{ workMs: COMFORTABLE_MS, atMs: 10_202, eligible: true }]); // gap 501
    const afterBreak = span(10, COMFORTABLE_MS, 10_702, 500);
    expect(afterBreak.at(-1)?.atMs).toBe(15_202);
    expect(feed(second, afterBreak)).toBe('ssgi-half');
    expect(second.diagnostics(15_202).recoveryElapsedMs).toBe(5_000);
    consoleSpy.mockRestore();
  });

  it('matrix 16: hidden/restored lifecycle invalidation needs a fresh ten seconds', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { gov, decidedAt } = degradedAtSsgiHalf();
    feed(gov, span(10, COMFORTABLE_MS, decidedAt + 1, 500)); // run 4500 by t=4701
    // The chain calls invalidateRecovery() when eligibility is lost (hidden tab, pagehide,
    // fallback, renderer error): the accumulated duration clears immediately, before any
    // further sample exists to carry an ineligible reading.
    gov.invalidateRecovery();
    expect(gov.diagnostics(4_702).recoveryElapsedMs).toBe(0);
    // Restored visibility requalifies from scratch at t=4801. Its second window completes at
    // t=14301 holding 9500 ms - the original run would read 14100 ms there, so the
    // invalidation is what keeps the level down - and the third completes at t=19301 with
    // 14500 ms and recovers.
    feed(gov, span(20, COMFORTABLE_MS, 4_801, 500));
    expect(gov.level).toBe('ssgi-half');
    expect(gov.diagnostics(14_301).recoveryElapsedMs).toBe(9_500);
    feed(gov, span(10, COMFORTABLE_MS, 14_801, 500));
    expect(gov.level).toBe('full');
    consoleSpy.mockRestore();
  });

  it('lifecycle invalidation drops an in-flight window but preserves committed downgrade state', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { gov, decidedAt } = degradedAtSsgiHalf();
    // One fully completed overload window is a committed patience reading and must survive; the
    // five good samples after it are only a partial measurement window and must not survive a tab
    // interruption or an ineligible graph reconstruction.
    feed(gov, span(10, 40, decidedAt + 1, 100));
    feed(gov, span(5, COMFORTABLE_MS, 1_201, 100));
    const before = gov.state;
    expect(before.consecutiveOverBudget).toBe(1);
    expect(before.samples.length).toBe(5);
    expect(before.recoveryStartedAtMs).toBe(1_201);

    gov.invalidateRecovery();
    const invalidated = gov.state;
    expect(invalidated.level).toBe('ssgi-half');
    expect(invalidated.cooldownUntilMs).toBe(before.cooldownUntilMs);
    expect(invalidated.events).toEqual(before.events);
    expect(invalidated.consecutiveOverBudget).toBe(1);
    expect(invalidated.samples).toEqual([]);
    expect(invalidated.recoveryStartedAtMs).toBeNull();
    expect(invalidated.lastEligibleSampleAtMs).toBeNull();
    expect(invalidated.lastSampleEligible).toBe(false);

    // Without the clear above, the preserved five samples plus these twenty-five would complete
    // a third window at t=14,000 and recover on stale pre-interruption p95 data. The fresh stream
    // has only two complete windows then, so it remains down even though its timer is qualified.
    feed(gov, span(25, COMFORTABLE_MS, 2_000, 500));
    expect(gov.level).toBe('ssgi-half');
    expect(gov.state.samples.length).toBe(5);
    // The next complete, entirely resumed window can recover normally.
    feed(gov, span(5, COMFORTABLE_MS, 14_500, 500));
    expect(gov.level).toBe('full');
    consoleSpy.mockRestore();
  });

  it('fails closed on invalid durations and a non-monotonic sample clock', () => {
    const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 10, patience: 2 });
    gov.observe(COMFORTABLE_MS, 100, true);
    const before = gov.state;

    expect(gov.observe(-1, 101, true)).toBe('full');
    expect(gov.state).toMatchObject({
      level: before.level,
      samples: [],
      consecutiveOverBudget: before.consecutiveOverBudget,
      cooldownUntilMs: before.cooldownUntilMs,
      recoveryStartedAtMs: null,
      lastEligibleSampleAtMs: null,
      lastObservedAtMs: 100,
      lastSampleEligible: false,
      events: before.events,
    });

    gov.observe(COMFORTABLE_MS, 102, true);
    expect(gov.state.recoveryStartedAtMs).toBe(102);
    expect(gov.observe(COMFORTABLE_MS, -1, true)).toBe('full');
    expect(gov.state.recoveryStartedAtMs).toBeNull();
    expect(gov.state.samples).toEqual([]);

    gov.observe(COMFORTABLE_MS, 103, true);
    expect(gov.observe(COMFORTABLE_MS, 99, true)).toBe('full');
    expect(gov.state.recoveryStartedAtMs).toBeNull();
    expect(gov.state.samples).toEqual([]);
  });

  it('fails closed on a non-finite sample clock', () => {
    const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 10, patience: 2 });
    gov.observe(COMFORTABLE_MS, 100, true);
    // NaN reaches the clock check itself: the monotonic comparison would let it
    // through, so the finite check is what drops the reading whole.
    expect(gov.observe(COMFORTABLE_MS, Number.NaN, true)).toBe('full');
    expect(gov.state.samples).toEqual([]);
    expect(gov.state.lastObservedAtMs).toBe(100);
    expect(gov.state.recoveryStartedAtMs).toBeNull();
  });

  it('accepts two samples that share one clock value', () => {
    const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 10, patience: 2 });
    // The clock guard is strictly monotonic: two frames can read one clock value,
    // and an equal timestamp is not a clock defect.
    gov.observe(COMFORTABLE_MS, 500, true);
    gov.observe(COMFORTABLE_MS, 500, true);
    expect(gov.state.samples).toEqual([COMFORTABLE_MS, COMFORTABLE_MS]);
    expect(gov.state.lastObservedAtMs).toBe(500);
    expect(gov.state.recoveryStartedAtMs).toBe(500);
  });

  it('matrix 18: cooldown blocks changes in both directions', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    // Downward block: after a recovery, over-budget windows rebuild the patience well inside
    // the cooldown, and the step back down only happens on the first window after it expires.
    const { gov, decidedAt } = degradedAtSsgiHalf();
    feed(gov, span(30, COMFORTABLE_MS, decidedAt + 1, 500)); // recovery at t=14701, cooldown to 24701
    expect(gov.level).toBe('full');
    feed(gov, span(20, 40, 14_702, 500)); // windows complete at 19202 and 24202: blocked
    expect(gov.level).toBe('full');
    expect(gov.diagnostics(24_202).consecutiveOverBudget).toBeGreaterThanOrEqual(2);
    expect(gov.diagnostics(24_202).cooldownRemainingMs).toBeGreaterThan(0);
    feed(gov, span(10, 40, 24_703, 500)); // the next window completes at 29203: one step down
    expect(gov.level).toBe('ssgi-half');

    // Upward block: a restored state whose qualification predates an active cooldown is the
    // one shape where a completed comfortable window is refused by the cooldown alone.
    const carried: GovernorState = {
      level: 'ssgi-half',
      samples: [],
      consecutiveOverBudget: 0,
      cooldownUntilMs: 30_000,
      recoveryStartedAtMs: 10_000,
      lastEligibleSampleAtMs: 29_000,
      windowAllEligible: true,
      lastP95Ms: COMFORTABLE_MS,
      lastObservedAtMs: 29_000,
      lastSampleEligible: true,
      events: [],
    };
    const restored = createGovernor({
      budgetMs: BUDGET_MS,
      windowFrames: 10,
      patience: 2,
      initialState: carried,
    });
    // Window completes at t=29451: run 19451 ms (qualified) but 549 ms of cooldown remain.
    feed(restored, span(10, COMFORTABLE_MS, 29_001, 50));
    expect(restored.level).toBe('ssgi-half');
    expect(restored.diagnostics(29_451).cooldownRemainingMs).toBe(549);
    // Past the cooldown, the next complete comfortable window recovers.
    feed(restored, span(10, COMFORTABLE_MS, 29_502, 500));
    expect(restored.level).toBe('full');
    consoleSpy.mockRestore();
  });

  it('matrix 19: every change resets the samples and both qualification counters', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { gov, decidedAt } = degradedAtSsgiHalf();
    // After the downgrade at t=200: window empty, patience 0, run null, cooldown until 10200.
    let state = gov.state;
    expect(state.samples).toEqual([]);
    expect(state.consecutiveOverBudget).toBe(0);
    expect(state.recoveryStartedAtMs).toBeNull();
    expect(state.cooldownUntilMs).toBe(decidedAt + LEVEL_CHANGE_COOLDOWN_MS);
    expect(gov.diagnostics(decidedAt + 1).activity).toBe('cooldown');

    feed(gov, span(30, COMFORTABLE_MS, decidedAt + 1, 500)); // recovery at t=14701
    expect(gov.level).toBe('full');
    state = gov.state;
    expect(state.samples).toEqual([]);
    expect(state.consecutiveOverBudget).toBe(0);
    expect(state.recoveryStartedAtMs).toBeNull();
    expect(state.cooldownUntilMs).toBe(14_701 + LEVEL_CHANGE_COOLDOWN_MS);
    expect(gov.diagnostics(14_702).activity).toBe('cooldown');
    consoleSpy.mockRestore();
  });
});
