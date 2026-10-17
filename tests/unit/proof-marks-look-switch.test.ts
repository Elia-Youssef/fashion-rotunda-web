// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { loadMarks } from '../support/proof-marks';

// The look-switch timer reading: the last look-switch measure's duration, with and without a
// usable performance object.

/** A User Timing measure shape, the entry type a look-switch timer records. */
function fakeMeasure(startTime: number, duration: number): PerformanceEntry {
  const entry: PerformanceEntry = {
    name: 'look-switch',
    entryType: 'measure',
    startTime,
    duration,
    toJSON: (): PerformanceEntry => entry,
  };
  return entry;
}

describe('latestLookSwitchMs', () => {
  it('returns null without a global performance object', async () => {
    const marks = await loadMarks();
    vi.stubGlobal('performance', undefined);
    expect(marks.latestLookSwitchMs()).toBeNull();
  });

  it('returns null when performance cannot list entries by name', async () => {
    const marks = await loadMarks();
    vi.stubGlobal('performance', { now: (): number => 0 });
    expect(marks.latestLookSwitchMs()).toBeNull();
  });

  it('returns null before any look-switch measure exists', async () => {
    const marks = await loadMarks();
    const entries = vi.spyOn(performance, 'getEntriesByName').mockReturnValue([]);
    expect(marks.latestLookSwitchMs()).toBeNull();
    expect(entries).toHaveBeenCalledWith('look-switch');
  });

  it('returns the last measure duration when several exist, not the first or the largest', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByName').mockReturnValue([
      fakeMeasure(100, 120),
      fakeMeasure(500, 900),
      fakeMeasure(2000, 250),
    ]);
    expect(marks.latestLookSwitchMs()).toBe(250);
  });
});
