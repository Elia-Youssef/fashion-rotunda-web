import { describe, expect, it, vi } from 'vitest';
import {
  createGovernor,
  LEVEL_CHANGE_COOLDOWN_MS,
  RECOVERY_QUALIFICATION_MS,
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

// Diagnostics and the event log: the readings and history the proof panel publishes.

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

  it('reports cooldown ahead of downgrade patience when both are true', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { gov } = degradedAtSsgiHalf(); // decided at t=200, cooldown until 10200
    feed(gov, span(10, 40, 201, 100)); // one over-budget window: patience 1 at t=1101
    const diagnostics = gov.diagnostics(1_200);
    expect(diagnostics.consecutiveOverBudget).toBe(1);
    expect(diagnostics.cooldownRemainingMs).toBeGreaterThan(0);
    // The status the proof panel prints while a fresh cooldown overlaps a partial
    // downgrade case is the cooldown: no new change can happen inside it.
    expect(diagnostics.activity).toBe('cooldown');
    consoleSpy.mockRestore();
  });

  it('never reports negative recovery elapsed time', () => {
    const carried: GovernorState = {
      level: 'ssgi-half',
      samples: [],
      consecutiveOverBudget: 0,
      cooldownUntilMs: 0,
      recoveryStartedAtMs: 20_000,
      lastEligibleSampleAtMs: 25_000,
      windowAllEligible: true,
      lastP95Ms: null,
      lastObservedAtMs: 25_000,
      lastSampleEligible: true,
      events: [],
    };
    const restored = createGovernor({
      budgetMs: BUDGET_MS,
      windowFrames: 10,
      patience: 2,
      initialState: carried,
    });
    // A reading clock older than the carried run start is a stale publish, not
    // negative qualification time; a later one still measures normally.
    expect(restored.diagnostics(10_000).recoveryElapsedMs).toBe(0);
    expect(restored.diagnostics(25_000).recoveryElapsedMs).toBe(5_000);
  });

  it('defaults the diagnostics clock to the last observed sample', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { gov } = degradedAtSsgiHalf(); // last observed sample at t=200
    const decided = gov.diagnostics();
    expect(decided.cooldownRemainingMs).toBe(LEVEL_CHANGE_COOLDOWN_MS);
    expect(decided.activity).toBe('cooldown');
    feed(gov, span(5, COMFORTABLE_MS, 10_300, 100)); // last observed t=10700, run from 10300
    expect(gov.diagnostics().recoveryElapsedMs).toBe(400);
    consoleSpy.mockRestore();
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
