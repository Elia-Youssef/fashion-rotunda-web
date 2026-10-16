import { describe, expect, it, vi } from 'vitest';
import {
  createGovernor,
  GOVERNOR_EVENT_LOG_CAP,
  LEVEL_CHANGE_COOLDOWN_MS,
} from '../../src/post/governor';
import type { EnhancedLevel, GovernorEvent, GovernorState } from '../../src/post/governor';
import { BUDGET_MS, COMFORTABLE_MS, feed, span } from '../support/post-governor';
import type { Sample } from '../support/post-governor';

// Snapshot, restoration and resize state transfer: round-trips, defensive copies,
// fail-closed validation, and a rebuilt governor deciding exactly as the uninterrupted one.

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

  it('matrix 22b: each restoration rejection fires for its own cause', () => {
    // Matrix 22 mutates a state whose active run makes several checks overlap
    // (an infinite eligible-sample clock also breaks the ordering rules, a
    // non-down event also breaks the one-step rule). These variants isolate
    // one check each and pin the exact cause string, so a guard that stops
    // firing cannot hide behind its neighbour.
    const activeRun: GovernorState = {
      level: 'ssgi-half',
      samples: [10, 12],
      consecutiveOverBudget: 0,
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
    const idleStream = (): GovernorState => ({
      ...structuredClone(activeRun),
      recoveryStartedAtMs: null,
      lastEligibleSampleAtMs: null,
      lastSampleEligible: false,
    });
    const options = { budgetMs: BUDGET_MS, windowFrames: 10, patience: 2 };
    const rejects = (state: GovernorState, message: string): void => {
      expect(() => createGovernor({ ...options, initialState: state })).toThrow(message);
    };
    // The idle variant itself stays acceptable.
    expect(() => createGovernor({ ...options, initialState: idleStream() })).not.toThrow();

    // A p95 no consumer can render, in the active profile.
    rejects(
      { ...structuredClone(activeRun), lastP95Ms: Number.POSITIVE_INFINITY },
      'invalid governor p95 reading',
    );
    // An eligible-sample clock that never existed, in a stream with no run to
    // order it against.
    const neverEligible = idleStream();
    neverEligible.lastEligibleSampleAtMs = Number.NEGATIVE_INFINITY;
    rejects(neverEligible, 'invalid governor recovery sample time');
    // An observation clock that never ticked.
    const nanObserved = idleStream();
    nanObserved.lastObservedAtMs = Number.NaN;
    rejects(nanObserved, 'invalid governor observation clock');
    // An eligible sample after the last observation is impossible ordering.
    const lateEligible = idleStream();
    lateEligible.lastEligibleSampleAtMs = 121;
    rejects(lateEligible, 'invalid governor eligible sample ordering');
    // A history that is not a list at all.
    rejects(
      { ...structuredClone(activeRun), events: {} as unknown as GovernorEvent[] },
      'invalid governor event history',
    );
    // Event causes, each shaped to pass the checks beside it.
    const eventVariant = (mutate: (event: GovernorEvent) => void): GovernorState => {
      const state = structuredClone(activeRun) as GovernorState;
      mutate(state.events[0] as GovernorEvent);
      return state;
    };
    rejects(
      eventVariant((event) => {
        event.direction = 'sideways' as 'down';
        event.from = 'ssgi-half';
        event.to = 'full';
      }),
      'invalid governor event direction',
    );
    rejects(
      eventVariant((event) => {
        event.to = 'warp' as EnhancedLevel;
      }),
      'invalid governor event level',
    );
    rejects(
      eventVariant((event) => {
        event.budgetMs = Number.NaN;
      }),
      'invalid governor event reading',
    );
    rejects(
      eventVariant((event) => {
        event.atMs = Number.NaN;
      }),
      'invalid governor event reading',
    );
  });

  it('a restored window marked ineligible stays ineligible through its completion', () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const carried: GovernorState = {
      level: 'ssgi-half',
      samples: [COMFORTABLE_MS, COMFORTABLE_MS],
      consecutiveOverBudget: 0,
      cooldownUntilMs: 0,
      recoveryStartedAtMs: null,
      lastEligibleSampleAtMs: null,
      windowAllEligible: false,
      lastP95Ms: null,
      lastObservedAtMs: 5_000,
      lastSampleEligible: false,
      events: [],
    };
    const restored = createGovernor({
      budgetMs: BUDGET_MS,
      windowFrames: 40,
      patience: 2,
      initialState: carried,
    });
    expect(restored.state.windowAllEligible).toBe(false);
    // The two carried samples complete a window with 38 resumed ones at
    // t=23500, the restarted run holding 18,400 ms: qualified in time, but not
    // in eligibility, so the rebuild may not launder the carried window.
    feed(restored, span(38, COMFORTABLE_MS, 5_100, 500));
    expect(restored.level).toBe('ssgi-half');
    // The next window starts fresh and all-eligible: it recovers normally.
    feed(restored, span(40, COMFORTABLE_MS, 24_000, 500));
    expect(restored.level).toBe('full');
    consoleSpy.mockRestore();
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
