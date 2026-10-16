import { describe, expect, it, vi } from 'vitest';
import { createGovernor, LEVEL_CHANGE_COOLDOWN_MS } from '../../src/post/governor';
import type { EnhancedLevel, GovernorState } from '../../src/post/governor';
import { BUDGET_MS, COMFORTABLE_MS, degradedAtSsgiHalf, feed, span } from '../support/post-governor';

// Downgrade behaviour: when the governor steps down, how far, and what it refuses to do.

/** Deterministic clock: the tests advance it by hand and pass the value into observe(). */
interface Clock {
  t: number;
}

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

  it('decides on every frame when the window is a single sample', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 1, patience: 2 });
    // A one-sample window completes on every frame: its p95 is that sample alone,
    // so the second over-budget frame is the second over-budget window and decides.
    expect(gov.observe(25.0, 100, true)).toBe('full');
    expect(gov.state.lastP95Ms).toBe(25);
    expect(gov.state.consecutiveOverBudget).toBe(1);
    expect(gov.observe(25.0, 200, true)).toBe('ssgi-half');
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

  it('resets the published patience once the ladder is exhausted at base', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const gov = createGovernor({ budgetMs: BUDGET_MS, windowFrames: 10, patience: 2 });
    feed(gov, span(80, 40, 10, 500)); // four downgrades; base reached at t=39510
    expect(gov.level).toBe('base');
    // Two more over-budget windows complete at t=46511 and t=51511, both past
    // the last cooldown (t=49510). The second reaches the decision point again
    // with nowhere left to step: the patience the proof panel publishes must
    // fall back to zero there, not grow without bound.
    feed(gov, span(20, 40, 42_011, 500));
    expect(gov.state.consecutiveOverBudget).toBe(0);
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
