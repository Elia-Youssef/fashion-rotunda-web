import { describe, expect, it, vi } from 'vitest';
import {
  createGovernor,
  governorOperates,
  GOVERNOR_EVENT_LOG_CAP,
  LEVEL_CHANGE_COOLDOWN_MS,
  RECOVERY_MAX_SAMPLE_GAP_MS,
  RECOVERY_QUALIFICATION_MS,
  RECOVERY_THRESHOLD_RATIO,
} from '../../src/post/governor';
import type { EnhancedLevel, Governor, GovernorEvent, GovernorState } from '../../src/post/governor';
import { postChainRebuildAllowed } from '../../src/post/chain';

// One-way degradation and safe recovery. Every test drives the governor on a
// deterministic fake clock: observe() takes the monotonic nowMs the decision clock runs on, so
// ten seconds of qualification and cooldown are exact integers here and wall time never leaks in.

const BUDGET_MS = 16.7;
const THRESHOLD_MS = BUDGET_MS * RECOVERY_THRESHOLD_RATIO;

/** Deterministic clock: the tests advance it by hand and pass the value into observe(). */
interface Clock {
  t: number;
}

interface Sample {
  workMs: number;
  atMs: number;
  eligible?: boolean;
}

function feed(gov: Governor, samples: readonly Sample[]): EnhancedLevel {
  let level = gov.level;
  for (const sample of samples) {
    level = gov.observe(sample.workMs, sample.atMs, sample.eligible ?? true);
  }
  return level;
}

/** count samples at startAt + k*gap for k = 0..count-1. */
function span(
  count: number,
  workMs: number,
  startAt: number,
  gap: number,
  eligible = true,
): Sample[] {
  const samples: Sample[] = [];
  for (let k = 0; k < count; k += 1) {
    samples.push({ workMs, atMs: startAt + k * gap, eligible });
  }
  return samples;
}

/**
 * Two over-budget windows of ten samples each, ten milliseconds apart: the governor decides at
 * t=200, lands on ssgi-half, and owes a cooldown until t=10200. Every recovery test starts here.
 */
function degradedAtSsgiHalf(overWorkMs = 40): { gov: Governor; decidedAt: number } {
  const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 10, patience: 2 });
  feed(gov, span(20, overWorkMs, 10, 10));
  expect(gov.level).toBe('ssgi-half');
  return { gov, decidedAt: 200 };
}

/** A comfortable work value safely under the 80% threshold (13.36 ms of the 16.7 ms budget). */
const COMFORTABLE_MS = 8;
/** Inside the borderline band: above 80% of budget, at or under the budget itself. */
const BORDERLINE_MS = 15;

describe('post governor: downgrade behaviour', () => {
  const defaultOptions = { budgetMs: 16.7, windowFrames: 60, patience: 2 };

  it('starts at full level and exposes the degradation ladder', () => {
    const gov = createGovernor(defaultOptions);
    expect(gov.level).toBe('full');
    expect(gov.ladder).toEqual(['full', 'ssgi-half', 'no-ssgi', 'no-ssr', 'base']);
  });

  it('uses direct SSR degradation and recovery when the graph has no SSGI', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gov = createGovernor({
      budgetMs: BUDGET_MS,
      windowFrames: 2,
      patience: 1,
      ssgiEnabled: false,
    });

    expect(gov.ladder).toEqual(['full', 'no-ssr', 'base']);
    feed(gov, span(2, 40, 10, 10));
    expect(gov.level).toBe('no-ssr');
    expect(gov.state.events[0]).toMatchObject({ direction: 'down', from: 'full', to: 'no-ssr' });

    // The stream remains eligible through the initial cooldown. Its final complete window is
    // after that cooldown and has accrued more than the required ten seconds, so recovery makes
    // exactly the inverse one-step transition.
    feed(gov, span(22, COMFORTABLE_MS, 30, 500));
    expect(gov.level).toBe('full');
    expect(gov.state.events[1]).toMatchObject({ direction: 'up', from: 'no-ssr', to: 'full' });

    // A snapshot from the SSGI profile cannot be restored into this shorter feature-aware ladder.
    const wrongProfile = structuredClone(gov.state) as GovernorState;
    wrongProfile.level = 'ssgi-half';
    expect(() =>
      createGovernor({
        budgetMs: BUDGET_MS,
        windowFrames: 2,
        patience: 1,
        ssgiEnabled: false,
        initialState: wrongProfile,
      }),
    ).toThrow('unknown governor level: ssgi-half');
    consoleSpy.mockRestore();
  });

  it('does not step down while frame work times remain under budget', () => {
    const gov = createGovernor(defaultOptions);
    const clock: Clock = { t: 0 };
    // Feed 180 frames (3 full windows) well under 16.7 ms budget.
    for (let i = 0; i < 180; i += 1) {
      clock.t += 16;
      expect(gov.observe(10.0, clock.t, true)).toBe('full');
    }
    expect(gov.level).toBe('full');
  });

  it('matrix 1: a downgrade needs p95 strictly greater than the budget, not equal', () => {
    const gov = createGovernor(defaultOptions);
    const clock: Clock = { t: 0 };
    // Every sample exactly at the budget: p95 == budget is not over budget (and not comfortable
    // enough to qualify for recovery either; it is the borderline band).
    for (let i = 0; i < 180; i += 1) {
      clock.t += 16;
      expect(gov.observe(BUDGET_MS, clock.t, true)).toBe('full');
    }
    expect(gov.level).toBe('full');
    expect(gov.state.consecutiveOverBudget).toBe(0);
  });

  it('matrix 2 and 3: two over-budget windows step down exactly one level, on the completing frame', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gov = createGovernor(defaultOptions);
    const clock: Clock = { t: 0 };
    const step = (): number => (clock.t += 16);

    // Window 1: p95 25 ms > 16.7 ms. Patience is 2: still full after one window.
    for (let i = 0; i < 60; i += 1) {
      gov.observe(25.0, step(), true);
    }
    expect(gov.level).toBe('full');
    expect(gov.state.consecutiveOverBudget).toBe(1);

    // Window 2 completes on its 60th frame: one step, to ssgi-half and no further.
    for (let i = 0; i < 59; i += 1) {
      expect(gov.observe(25.0, step(), true)).toBe('full');
    }
    expect(gov.observe(25.0, step(), true)).toBe('ssgi-half');
    expect(gov.level).toBe('ssgi-half');
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls[0][0]).toContain('stepped down to ssgi-half');
    consoleSpy.mockRestore();
  });

  it('matrix 17: a partial window never decides anything', () => {
    const gov = createGovernor(defaultOptions);
    const clock: Clock = { t: 0 };
    // 59 of 60 samples over budget: no completion, no downgrade.
    for (let i = 0; i < 59; i += 1) {
      gov.observe(30.0, (clock.t += 16), true);
    }
    expect(gov.level).toBe('full');
    expect(gov.state.consecutiveOverBudget).toBe(0);

    // And a partially filled comfortable window never recovers either, however long the
    // qualification run already is: this restored governor owes 59 more samples.
    const carried: GovernorState = {
      level: 'ssgi-half',
      samples: [],
      consecutiveOverBudget: 0,
      cooldownUntilMs: 0,
      recoveryStartedAtMs: 15_000,
      lastEligibleSampleAtMs: 20_000,
      windowAllEligible: true,
      lastP95Ms: COMFORTABLE_MS,
      lastObservedAtMs: 20_000,
      lastSampleEligible: true,
      events: [],
    };
    const restored = createGovernor({ ...defaultOptions, initialState: carried });
    clock.t = 20_000;
    for (let i = 0; i < 59; i += 1) {
      expect(restored.observe(COMFORTABLE_MS, (clock.t += 170), true)).toBe('ssgi-half');
    }
    // The 60th completes the window and the run is long since qualified: exactly one step up.
    expect(restored.observe(COMFORTABLE_MS, (clock.t += 170), true)).toBe('full');
  });

  it('resets consecutive over-budget count when a window comes in under budget', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gov = createGovernor({ budgetMs: 16.7, windowFrames: 10, patience: 2 });
    const clock: Clock = { t: 0 };
    const windowOf = (workMs: number): void => {
      for (let i = 0; i < 10; i += 1) {
        gov.observe(workMs, (clock.t += 100), true);
      }
    };

    windowOf(20.0); // over, patience 1
    windowOf(20.0); // over, patience 2 -> ssgi-half at t=200, cooldown until 10200
    expect(gov.level).toBe('ssgi-half');
    windowOf(12.0); // comfortable: patience resets
    expect(gov.state.consecutiveOverBudget).toBe(0);
    windowOf(20.0); // over again: patience 1, not 2
    expect(gov.level).toBe('ssgi-half');
    expect(gov.state.consecutiveOverBudget).toBe(1);
    consoleSpy.mockRestore();
  });

  it('matrix 11: degrades down the ladder in order and never below base, one cooldown at a time', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 10, patience: 2 });
    const clock: Clock = { t: 0 };
    const expectedSteps: EnhancedLevel[] = ['ssgi-half', 'no-ssgi', 'no-ssr', 'base'];
    for (const step of expectedSteps) {
      // Over-budget samples 500 ms apart: a window completes every 5 s, two windows rebuild the
      // patience in 10 s, which is exactly the cooldown, so the next decision lands 20 samples
      // after the previous one. The loop stops at the first level change.
      let last = gov.level;
      for (let i = 0; i < 25 && last === gov.level; i += 1) {
        last = gov.observe(22.0, (clock.t += 500), true);
      }
      expect(gov.level).toBe(step);
    }

    // Further over-budget windows cannot degrade past base, and log nothing more.
    const callsAfterBase = consoleSpy.mock.calls.length;
    for (let i = 0; i < 40; i += 1) {
      gov.observe(30.0, (clock.t += 500), true);
    }
    expect(gov.level).toBe('base');
    expect(consoleSpy.mock.calls.length).toBe(callsAfterBase);
    expect(consoleSpy).toHaveBeenCalledTimes(4);
    for (let idx = 0; idx < expectedSteps.length; idx += 1) {
      expect(consoleSpy.mock.calls[idx][0]).toContain(`stepped down to ${expectedSteps[idx]}`);
      expect(consoleSpy.mock.calls[idx][0]).toContain('[archviz]');
    }
    consoleSpy.mockRestore();
  });

  it('matrix 4: persistent overload moves at most one level per cooldown', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { gov, decidedAt } = degradedAtSsgiHalf();
    // Over-budget windows keep completing every 500 ms. Patience is satisfied again by t=1151,
    // but the cooldown runs to 10200: no second step until a window completes after that.
    const firstHundred = span(100, 40, decidedAt + 1, 50);
    expect(feed(gov, firstHundred)).toBe('ssgi-half');
    const midDiagnostics = gov.diagnostics(decidedAt + 1 + 99 * 50);
    expect(midDiagnostics.consecutiveOverBudget).toBeGreaterThanOrEqual(2);
    expect(midDiagnostics.cooldownRemainingMs).toBeGreaterThan(0);

    // The first window completion at or after the cooldown end is t=10651 (sample 210): the
    // second step, and no third follows inside the new cooldown.
    const secondChunk = span(120, 40, decidedAt + 1 + 100 * 50, 50);
    expect(feed(gov, secondChunk)).toBe('no-ssgi');
    const events = gov.diagnostics().events;
    expect(events.length).toBe(2);
    expect(events[1].direction).toBe('down');
    expect(events[1].atMs).toBeGreaterThanOrEqual(decidedAt + LEVEL_CHANGE_COOLDOWN_MS);
    consoleSpy.mockRestore();
  });

  it('does not recover when the sample stream is never recovery-eligible', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 10, patience: 2 });
    // Downgrade on ineligible samples (downgrades do not need eligibility)...
    feed(gov, span(20, 40, 10, 10, false));
    expect(gov.level).toBe('ssgi-half');
    // ...then five windows far below budget, all ineligible: no re-ascension.
    feed(gov, span(50, COMFORTABLE_MS, 201, 100, false));
    expect(gov.level).toBe('ssgi-half');
    expect(gov.diagnostics(10_000).recoveryElapsedMs).toBe(0);
    consoleSpy.mockRestore();
  });

  it('allows the caller to exclude idle frames from feeding the window', () => {
    const gov = createGovernor({ budgetMs: 16.7, windowFrames: 10, patience: 1 });
    const clock: Clock = { t: 0 };
    // Caller feeds only active drawn frames; the governor window is frame-counted, so idle wall
    // time between the calls can never complete (or break) a window on its own.
    for (let i = 0; i < 5; i += 1) {
      gov.observe(25.0, (clock.t += 100), true);
    }
    expect(gov.level).toBe('full');
    for (let i = 0; i < 5; i += 1) {
      gov.observe(25.0, (clock.t += 100), true);
    }
    expect(gov.level).toBe('ssgi-half');
  });
});

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

describe('post governor: snapshot, restoration and resize state transfer', () => {
  /** A mid-decision state: degraded, patience 1, mid-window, mid-run, inside cooldown. */
  function richState(): GovernorState {
    const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 10, patience: 2 });
    feed(gov, span(20, 40, 10, 10)); // downgrade to ssgi-half at t=200, cooldown to 10200
    feed(gov, span(10, 40, 201, 50)); // one over-budget window: patience 1, p95 40
    feed(gov, span(5, COMFORTABLE_MS, 701, 300)); // partial window, run from 701
    const state = gov.state;
    expect(state.level).toBe('ssgi-half');
    expect(state.samples).toEqual([COMFORTABLE_MS, COMFORTABLE_MS, COMFORTABLE_MS, COMFORTABLE_MS, COMFORTABLE_MS]);
    expect(state.consecutiveOverBudget).toBe(1);
    expect(state.cooldownUntilMs).toBe(10_200);
    expect(state.recoveryStartedAtMs).toBe(701);
    expect(state.lastEligibleSampleAtMs).toBe(1_901);
    expect(state.windowAllEligible).toBe(true);
    expect(state.lastP95Ms).toBe(40);
    expect(state.events.length).toBe(1);
    return state;
  }

  it('matrix 20 and 23: a snapshot round-trip preserves every carried value', () => {
    const carried = richState();
    const restored = createGovernor({
      budgetMs: BUDGET_MS,
      windowFrames: 10,
      patience: 2,
      initialState: carried,
    });
    expect(restored.state).toEqual(carried);
    const before = restored.diagnostics(2_500);
    expect(before.level).toBe('ssgi-half');
    expect(before.consecutiveOverBudget).toBe(1);
    expect(before.cooldownRemainingMs).toBe(10_200 - 2_500);
    expect(before.recoveryElapsedMs).toBe(2_500 - 701);
    expect(before.lastP95Ms).toBe(40);
    expect(before.events.length).toBe(1);
  });

  it('matrix 21: snapshot arrays are defensive copies in both directions', () => {
    const carried = richState();
    const restored = createGovernor({
      budgetMs: BUDGET_MS,
      windowFrames: 10,
      patience: 2,
      initialState: carried,
    });
    // Mutating the snapshot the governor handed out...
    const snapshot = restored.state;
    (snapshot.samples as number[]).push(9_999);
    (snapshot.events as GovernorEvent[]).push({
      direction: 'down',
      from: 'full',
      to: 'ssgi-half',
      p95Ms: 1,
      budgetMs: BUDGET_MS,
      atMs: 1,
      reason: 'forged',
    });
    expect(restored.state.samples).toEqual(carried.samples);
    expect(restored.state.events.length).toBe(1);
    // ...and mutating the initialState the caller passed in.
    (carried.samples as number[]).push(9_999);
    (carried.events as GovernorEvent[]).pop();
    expect(restored.state.samples.length).toBe(5);
    expect(restored.state.events.length).toBe(1);
  });

  it('matrix 22: invalid state restoration fails closed', () => {
    const valid: GovernorState = {
      level: 'ssgi-half',
      samples: [10, 12],
      consecutiveOverBudget: 3,
      cooldownUntilMs: 500,
      recoveryStartedAtMs: 100,
      lastEligibleSampleAtMs: 120,
      windowAllEligible: true,
      lastP95Ms: 12.5,
      lastObservedAtMs: 120,
      lastSampleEligible: true,
      events: [
        {
          direction: 'down',
          from: 'full',
          to: 'ssgi-half',
          p95Ms: 19.4,
          budgetMs: BUDGET_MS,
          atMs: 100,
          reason: 'p95 19.4 ms > 16.7 ms',
        },
      ],
    };
    const options = { budgetMs: BUDGET_MS, windowFrames: 10, patience: 2 };
    // The untouched state is acceptable, including a patience count above the limit (it grows
    // while a satisfied decision waits out a cooldown).
    expect(() => createGovernor({ ...options, initialState: { ...valid } })).not.toThrow();

    const rejects = (mutate: (state: GovernorState) => void): void => {
      const state = structuredClone(valid) as GovernorState;
      mutate(state);
      expect(() => createGovernor({ ...options, initialState: state })).toThrow();
    };
    rejects((s) => {
      s.level = 'turbo' as EnhancedLevel;
    });
    rejects((s) => {
      s.samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    }); // a full window can never be in flight
    rejects((s) => {
      s.samples = [Number.NaN];
    });
    rejects((s) => {
      s.samples = [-1];
    });
    rejects((s) => {
      s.consecutiveOverBudget = -1;
    });
    rejects((s) => {
      s.consecutiveOverBudget = 1.5;
    });
    rejects((s) => {
      s.cooldownUntilMs = Number.NaN;
    });
    rejects((s) => {
      s.cooldownUntilMs = -1;
    });
    rejects((s) => {
      s.recoveryStartedAtMs = -5;
    });
    rejects((s) => {
      s.lastEligibleSampleAtMs = Number.POSITIVE_INFINITY;
    });
    rejects((s) => {
      s.recoveryStartedAtMs = 121;
    }); // recovery cannot begin after its last eligible sample at 120
    rejects((s) => {
      s.lastEligibleSampleAtMs = null;
    }); // an active recovery run must have an eligible sample clock
    rejects((s) => {
      s.lastSampleEligible = false;
    }); // an active recovery run cannot end on an ineligible sample
    rejects((s) => {
      s.windowAllEligible = false;
    }); // an active recovery run cannot occupy a window already marked ineligible
    rejects((s) => {
      s.lastEligibleSampleAtMs = 119;
    }); // when the last sample is eligible, its clock must be the last observation clock
    rejects((s) => {
      s.lastEligibleSampleAtMs = 121;
    }); // an eligible sample cannot be later than the last observation at 120
    rejects((s) => {
      s.windowAllEligible = 'yes' as unknown as boolean;
    });
    rejects((s) => {
      s.lastP95Ms = -1;
    });
    rejects((s) => {
      s.lastObservedAtMs = Number.NaN;
    });
    rejects((s) => {
      s.lastSampleEligible = 'yes' as unknown as boolean;
    });
    rejects((s) => {
      s.events = new Array(GOVERNOR_EVENT_LOG_CAP + 1).fill(valid.events[0]);
    });
    rejects((s) => {
      s.events = [{ ...valid.events[0], direction: 'sideways' as 'down' }];
    });
    rejects((s) => {
      s.events = [{ ...valid.events[0], from: 'full', to: 'no-ssgi' }];
    }); // two levels in one event
    rejects((s) => {
      s.events = [{ ...valid.events[0], p95Ms: Number.NaN }];
    });
    rejects((s) => {
      s.events = [{ ...valid.events[0], reason: '' }];
    });
  });

  it('matrix 24: a restored governor makes the same next decision as the uninterrupted one', () => {
    const carried = richState();
    const original = createGovernor({
      budgetMs: BUDGET_MS,
      windowFrames: 10,
      patience: 2,
      initialState: structuredClone(carried) as GovernorState,
    });
    const restored = createGovernor({
      budgetMs: BUDGET_MS,
      windowFrames: 10,
      patience: 2,
      initialState: carried,
    });
    // The same stream drives both. The preserved patience window completes over budget at
    // t=3402, the satisfied decision waits out the carried cooldown until t=10902, and the
    // rebuild must neither skip nor soften that pending downgrade.
    let t = 1_902;
    const stream: Sample[] = [];
    for (let i = 0; i < 40; i += 1) {
      t += 300;
      stream.push({ workMs: 40, atMs: t, eligible: true });
    }
    for (const sample of stream) {
      expect(original.observe(sample.workMs, sample.atMs, sample.eligible ?? true)).toBe(
        restored.observe(sample.workMs, sample.atMs, sample.eligible ?? true),
      );
    }
    expect(original.state).toEqual(restored.state);
    expect(original.level).toBe('no-ssgi');
    // ...then a comfortable stretch recovers both identically (the run's first completion past
    // 10 s at this spacing is its 40th sample, t=25903).
    let t2 = t;
    const recovery: Sample[] = [];
    for (let i = 0; i < 45; i += 1) {
      t2 += 300;
      recovery.push({ workMs: COMFORTABLE_MS, atMs: t2, eligible: true });
    }
    for (const sample of recovery) {
      expect(original.observe(sample.workMs, sample.atMs, sample.eligible ?? true)).toBe(
        restored.observe(sample.workMs, sample.atMs, sample.eligible ?? true),
      );
    }
    expect(original.state).toEqual(restored.state);
    expect(original.level).toBe('ssgi-half');
  });

  it('matrix 23 (events): a rebuilt governor keeps the bounded event history and caps it', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 10, patience: 2 });
    // Walk down four (decisions at samples 20/40/60/80) and up three (recovery every 30
    // comfortably-under-budget samples): seven events, all carried by the snapshot.
    feed(gov, span(80, 40, 10, 500));
    expect(gov.level).toBe('base');
    feed(gov, span(90, COMFORTABLE_MS, 40_011, 500));
    expect(gov.level).toBe('ssgi-half');
    expect(gov.state.events.length).toBe(7);

    const rebuilt = createGovernor({
      budgetMs: BUDGET_MS,
      windowFrames: 10,
      patience: 2,
      initialState: gov.state,
    });
    expect(rebuilt.state.events.length).toBe(7);
    // Two more changes push the log to nine events: the cap keeps the newest eight, so only
    // the oldest (full -> ssgi-half) is dropped.
    feed(rebuilt, span(40, 40, 84_512, 500));
    expect(rebuilt.level).toBe('no-ssgi');
    feed(rebuilt, span(35, COMFORTABLE_MS, 104_513, 500));
    expect(rebuilt.level).toBe('ssgi-half');
    const events = rebuilt.state.events;
    expect(events.length).toBe(GOVERNOR_EVENT_LOG_CAP);
    expect(events[0].direction).toBe('down');
    expect(events[0].from).toBe('ssgi-half');
    expect(events[0].to).toBe('no-ssgi');
    expect(events[7].direction).toBe('up');
    expect(events[7].from).toBe('no-ssgi');
    expect(events[7].to).toBe('ssgi-half');
    consoleSpy.mockRestore();
  });

  it('preserves a degraded p95/patience window across a CSS-box post-chain replacement', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const options = { budgetMs: 16.7, windowFrames: 4, patience: 2 };
    const beforeResize = createGovernor(options);
    let t = 0;
    const tick = (): number => (t += 10);

    // Two complete over-budget windows reach ssgi-half. A third partial decision is intentionally
    // left in flight: replacing a temporal post graph here must retain both it and the level.
    for (let frame = 0; frame < 8; frame += 1) {
      beforeResize.observe(25, tick(), true);
    }
    for (let frame = 0; frame < 6; frame += 1) {
      beforeResize.observe(25, tick(), true);
    }
    expect(beforeResize.level).toBe('ssgi-half');
    const carried = beforeResize.state;
    expect(carried).toEqual({
      level: 'ssgi-half',
      samples: [25, 25],
      consecutiveOverBudget: 1,
      cooldownUntilMs: 80 + LEVEL_CHANGE_COOLDOWN_MS,
      // The decision at t=80 cleared the run; the over-budget completion at t=120 cleared it
      // again; the partial window's eligible sample at t=130 restarted it.
      recoveryStartedAtMs: 130,
      lastEligibleSampleAtMs: 140,
      windowAllEligible: true,
      lastP95Ms: 25,
      lastObservedAtMs: 140,
      lastSampleEligible: true,
      events: [
        {
          direction: 'down',
          from: 'full',
          to: 'ssgi-half',
          p95Ms: 25,
          budgetMs: 16.7,
          atMs: 80,
          reason: 'p95 25.0 ms > 16.7 ms',
        },
      ],
    });

    const afterResize = createGovernor({ ...options, initialState: carried });
    expect(afterResize.state).toEqual(carried);

    // The next two samples complete the preserved patience window at t=10110, past the
    // t=10080 cooldown. Both governors make exactly the same next decision, proving the
    // rebuild neither improves, resets, nor skips a level.
    for (const at of [10_100, 10_110]) {
      expect(afterResize.observe(25, at, true)).toBe(beforeResize.observe(25, at, true));
    }
    expect(afterResize.state).toEqual(beforeResize.state);
    expect(afterResize.level).toBe('no-ssgi');
    consoleSpy.mockRestore();
  });
});

describe('post governor: where a governor exists at all (matrix 25)', () => {
  // The chain builds no governor for the WebGL 2 backend, for any forced `?post=` slice, or on
  // the pass-through fallback path, so those modes can neither degrade nor recover; the pure
  // rule below is the one the chain reads (chain.ts applyDevSwitch) so it cannot drift.
  const enhancedHigh = { ssgi: 'full-with-half-fallback' as const, ssr: true };
  const midWithoutCompute = { ssgi: 'off' as const, ssr: false };

  it('operates only on the unforced enhanced WebGPU path', () => {
    expect(governorOperates('webgpu', enhancedHigh, false)).toBe(true);
    expect(governorOperates('webgpu', enhancedHigh, true)).toBe(false); // ?post= slice
    expect(governorOperates('webgl2', enhancedHigh, false)).toBe(false);
    expect(governorOperates('webgl2', enhancedHigh, true)).toBe(false);
    expect(governorOperates('webgpu', midWithoutCompute, false)).toBe(false); // no SSGI/SSR tier
  });

  it('keeps a runtime pass-through fallback through a CSS-box resize', () => {
    expect(postChainRebuildAllowed(false)).toBe(true);
    expect(postChainRebuildAllowed(true)).toBe(false);
  });
});

describe('post governor: diagnostics and the event log (matrix 26)', () => {
  it('exposes the constants and a truthful status between decisions', () => {
    const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 10, patience: 2 });
    const fresh = gov.diagnostics(0);
    expect(fresh.level).toBe('full');
    expect(fresh.activity).toBe('observing');
    expect(fresh.recoveryEligible).toBe(false);
    expect(fresh.cooldownRemainingMs).toBe(0);
    expect(fresh.recoveryElapsedMs).toBe(0);
    expect(fresh.lastP95Ms).toBeNull();
    expect(fresh.budgetMs).toBe(BUDGET_MS);
    expect(fresh.recoveryThresholdMs).toBe(THRESHOLD_MS);
    expect(fresh.recoveryQualificationMs).toBe(RECOVERY_QUALIFICATION_MS);
    expect(fresh.events).toEqual([]);

    feed(gov, span(10, 40, 10, 10)); // one over-budget window: patience 1 of 2
    const patienceOne = gov.diagnostics(150);
    expect(patienceOne.activity).toBe('downgrade-patience');
    expect(patienceOne.consecutiveOverBudget).toBe(1);
    expect(patienceOne.patience).toBe(2);
    expect(patienceOne.lastP95Ms).toBe(40);

    feed(gov, span(10, 40, 201, 50)); // second window: decision at t=651, cooldown until 10651
    expect(gov.level).toBe('ssgi-half');
    const decided = gov.diagnostics(700);
    expect(decided.activity).toBe('cooldown');
    expect(decided.cooldownRemainingMs).toBe(10_651 - 700);

    feed(gov, span(5, COMFORTABLE_MS, 701, 100)); // partial comfortable window, run accruing
    const qualifying = gov.diagnostics(11_000);
    expect(qualifying.activity).toBe('recovery-qualifying');
    expect(qualifying.recoveryElapsedMs).toBe(11_000 - 701);
    expect(qualifying.recoveryEligible).toBe(true);
  });

  it('resetSamplingState empties the stream state but keeps level, cooldown and history', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { gov, decidedAt } = degradedAtSsgiHalf();
    feed(gov, span(10, 40, decidedAt + 1, 50)); // patience 1, p95 40
    feed(gov, span(5, COMFORTABLE_MS, 701, 300)); // partial window, run from 701
    gov.resetSamplingState();
    const state = gov.state;
    expect(state.samples).toEqual([]);
    expect(state.consecutiveOverBudget).toBe(0);
    expect(state.recoveryStartedAtMs).toBeNull();
    expect(state.lastEligibleSampleAtMs).toBeNull();
    expect(state.windowAllEligible).toBe(true);
    // The committed decision state survives for the deterministic harness that takes over.
    expect(state.level).toBe('ssgi-half');
    expect(state.cooldownUntilMs).toBe(10_200);
    expect(state.events.length).toBe(1);
    consoleSpy.mockRestore();
  });

  it('matrix 26: the event log records order, direction, values and stays capped', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 10, patience: 2 });
    feed(gov, span(20, 40, 10, 10)); // down full -> ssgi-half at t=200, p95 40
    feed(gov, span(30, COMFORTABLE_MS, 201, 500)); // up ssgi-half -> full at t=14701, p95 8

    const events = gov.diagnostics().events;
    expect(events.length).toBe(2);
    expect(events[0]).toEqual({
      direction: 'down',
      from: 'full',
      to: 'ssgi-half',
      p95Ms: 40,
      budgetMs: BUDGET_MS,
      atMs: 200,
      reason: 'p95 40.0 ms > 16.7 ms',
    });
    expect(events[1].direction).toBe('up');
    expect(events[1].from).toBe('ssgi-half');
    expect(events[1].to).toBe('full');
    expect(events[1].p95Ms).toBe(COMFORTABLE_MS);
    expect(events[1].budgetMs).toBe(BUDGET_MS);
    expect(events[1].atMs).toBe(14_701);
    expect(events[1].reason).toBe(
      `p95 ${COMFORTABLE_MS.toFixed(1)} ms <= ${THRESHOLD_MS.toFixed(2)} ms after 14.5 s`,
    );
    consoleSpy.mockRestore();
  });
});

// Matrix 27 (proof snapshots and panel rows show the same committed governor state) lives in
// tests/unit/proof-marks.test.ts and tests/unit/proof-panel.test.ts, which read the same
// data-governor strings the composition root publishes.
