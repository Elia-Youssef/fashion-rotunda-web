// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { fakeResource, loadMarks } from '../support/proof-marks';

// The first-frame mark itself: writing it exactly once, reading its timestamp back, and the
// callbacks that wait for it through an AbortSignal.

describe('markFirstFrame and firstFrameMs', () => {
  it('retries absent marks, skips non-marks and caches the first immutable timestamp', async () => {
    const marks = await loadMarks();
    const entries = vi.spyOn(performance, 'getEntriesByName').mockReturnValue([]);
    expect(marks.firstFrameMs()).toBeNull();
    entries.mockReturnValue([
      { ...fakeResource('first-frame', 0, 1), entryType: 'measure', startTime: 3 },
      { ...fakeResource('first-frame', 0, 1), entryType: 'mark', startTime: 0 },
      { ...fakeResource('first-frame', 0, 1), entryType: 'mark', startTime: 99 },
    ]);
    expect(marks.firstFrameMs()).toBe(0);
    expect(marks.firstFrameMs()).toBe(0);
    expect(entries).toHaveBeenCalledTimes(2);
  });

  it('returns null before the first frame was marked', async () => {
    const marks = await loadMarks();
    expect(marks.firstFrameMs()).toBeNull();
  });

  it('marks exactly once even when called twice', async () => {
    const marks = await loadMarks();
    marks.markFirstFrame(() => 1000);
    marks.markFirstFrame(() => 9999);
    expect(marks.firstFrameMs()).toBe(1000);
    expect(performance.getEntriesByName('first-frame').length).toBe(1);
  });

  it('uses the injected clock as the mark timestamp', async () => {
    const marks = await loadMarks();
    marks.markFirstFrame(() => 4321);
    expect(marks.firstFrameMs()).toBe(4321);
  });

  it('uses the real clock when no clock is injected', async () => {
    const marks = await loadMarks();
    const before = performance.now();
    marks.markFirstFrame();
    const after = performance.now();
    const value = marks.firstFrameMs();
    if (value === null) {
      throw new Error('markFirstFrame did not produce a readable mark');
    }
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });
});

describe('afterFirstFrame', () => {
  it('runs the callback once, synchronously, when the mark already exists', async () => {
    const marks = await loadMarks();
    marks.markFirstFrame(() => 50);
    const calls: string[] = [];
    marks.afterFirstFrame(() => { calls.push('ready'); }, new AbortController().signal);
    expect(calls).toEqual(['ready']);
  });

  it('never runs the callback for a signal aborted before registration', async () => {
    const marks = await loadMarks();
    marks.markFirstFrame(() => 50);
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    marks.afterFirstFrame(() => { calls.push('ready'); }, controller.signal);
    expect(calls).toEqual([]);
  });

  it('drops a pending callback when the signal aborts before the mark', async () => {
    const marks = await loadMarks();
    const controller = new AbortController();
    const calls: string[] = [];
    marks.afterFirstFrame(() => { calls.push('ready'); }, controller.signal);
    controller.abort();
    marks.markFirstFrame(() => 50);
    expect(calls).toEqual([]);
  });

  it('stops the later callbacks when an earlier one aborts the shared signal', async () => {
    const marks = await loadMarks();
    const controller = new AbortController();
    const calls: string[] = [];
    marks.afterFirstFrame(() => {
      calls.push('first');
      controller.abort();
    }, controller.signal);
    marks.afterFirstFrame(() => { calls.push('second'); }, controller.signal);
    // The mark notifies over a copy of the listener set, so the second listener still runs
    // after the abort; only the aborted check keeps its callback from firing.
    marks.markFirstFrame(() => 50);
    expect(calls).toEqual(['first']);
  });
});
