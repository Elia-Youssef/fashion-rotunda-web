import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createGovernor, GOVERNOR_EVENT_LOG_CAP } from '../../src/post/governor';

// The governor's two per-window array costs: the p95 used to copy the window before sorting it on
// every completion, and the event-log eviction used to build a removed-elements array with splice
// only to drop it. The window is now sorted in place (it is cleared right after the read) and the
// oldest event leaves through shift. Behaviour is pinned on interleaved governors; the source
// checks fail if a copy or a splice returns.

const governorSource = readFileSync(new URL('../../src/post/governor.ts', import.meta.url), 'utf8');

/** Two complete windows of two samples each, read off the diagnostics between completions. */
describe('post governor window arrays', () => {
  it('keeps nearest-rank p95 correct for interleaved governors, window after window', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const first = createGovernor({ budgetMs: 100, windowFrames: 2, patience: 8 });
      const second = createGovernor({ budgetMs: 100, windowFrames: 2, patience: 8 });

      first.observe(40, 100, false);
      second.observe(1, 110, false);
      first.observe(2, 120, false);
      // Nearest-rank on [40, 2]: rank ceil(1.9) = 2, so 40, not the insertion order's last value.
      expect(first.diagnostics().lastP95Ms).toBe(40);

      second.observe(50, 130, false);
      expect(second.diagnostics().lastP95Ms).toBe(50);

      // The completed windows are gone: the next window of the first governor holds only its own
      // two fresh samples.
      first.observe(3, 140, false);
      first.observe(7, 150, false);
      expect(first.diagnostics().lastP95Ms).toBe(7);

      // A three-sample window sorts into ascending order before the rank reads it.
      const third = createGovernor({ budgetMs: 100, windowFrames: 3, patience: 8 });
      third.observe(5, 160, false);
      third.observe(9, 170, false);
      third.observe(1, 180, false);
      expect(third.diagnostics().lastP95Ms).toBe(9);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps the event log capped at the newest entries when a change is committed', () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      // Over-budget windows at the last ladder step commit no change, so the events only grow
      // while the ladder has steps to take; four over-budget windows drive two downgrades, one
      // per patience run, with the 10 s cooldown between them long past at a 20 s window cadence.
      const governor = createGovernor({ budgetMs: 10, windowFrames: 2, patience: 2 });
      let clock = 0;
      const window = (workMs: number): void => {
        governor.observe(workMs, clock += 20_000, false);
        governor.observe(workMs, clock += 20_000, false);
      };
      window(50);
      window(50);
      window(50);
      window(50);
      expect(governor.diagnostics().events).toHaveLength(2);
      const afterDown = governor.diagnostics().events;
      expect(afterDown.map((event) => event.direction)).toEqual(['down', 'down']);

      // Recovery needs eligible samples no more than 500 ms apart: 60 of them at a 250 ms cadence,
      // starting well past the 10 s cooldown of the last downgrade, complete comfortable windows
      // and the full 10 s qualification, so the ladder climbs one step and logs the event.
      for (let step = 0; step < 60; step += 1) {
        governor.observe(1, clock = 200_000 + (step + 1) * 250, true);
      }
      const events = governor.diagnostics().events;
      expect(events.length).toBeLessThanOrEqual(GOVERNOR_EVENT_LOG_CAP);
      expect(events[events.length - 1]?.direction).toBe('up');
      // The oldest entries were evicted, the newest kept, in order.
      for (let index = 1; index < events.length; index += 1) {
        expect(events[index]!.atMs).toBeGreaterThan(events[index - 1]!.atMs);
      }
    } finally {
      log.mockRestore();
    }
  });

  it('sorts the p95 window in place and evicts events without a discarded splice array', () => {
    const p95 = governorSource.match(/function calculateP95[\s\S]*?\n\}/);
    expect(p95, 'calculateP95 is present').not.toBeNull();
    expect(p95![0], 'the p95 window is sorted in place, not copied').not.toContain('...');
    expect(p95![0], 'the p95 window is sorted in place').toContain('window.sort(');

    expect(governorSource, 'no discarded removed-elements array from splice').not.toContain('.splice(');
  });
});
