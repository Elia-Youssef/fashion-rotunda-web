// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { fakeResource, loadMarks } from '../support/proof-marks';

// Readings derived from the Resource Timing buffer: the payload byte sums, the cold or warm
// cache state, and the three scene files behind the payload budget row.

describe('payloadBytes', () => {
  it('sums transferSize over resource entries and counts zero-size entries as zero', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('scene.bin', 1000, 20),
      fakeResource('lut.png', 2500, 30),
      // Cache hit: transferSize 0 is honest, see the comment in marks.ts.
      fakeResource('cached.bin', 0, 31),
    ]);
    expect(marks.payloadBytes()).toBe(3500);
  });

  it('returns 0 when there are no resource entries', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([]);
    expect(marks.payloadBytes()).toBe(0);
  });

  it('with untilFirstFrame sums only entries that ended at or before the mark', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('before.bin', 700, 24.9),
      fakeResource('at.bin', 300, 25),
      fakeResource('after.bin', 900, 25.1),
    ]);
    marks.markFirstFrame(() => 25);
    expect(marks.payloadBytes(true)).toBe(1000);
  });

  it('with untilFirstFrame returns 0 before the mark exists', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('scene.bin', 1000, 20),
    ]);
    expect(marks.payloadBytes(true)).toBe(0);
  });
});

describe('cacheState', () => {
  it('returns cold when rotunda.glb has transferSize > 0', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('content/rotunda.glb', 12345, 100),
    ]);
    expect(marks.cacheState()).toBe('cold');
  });

  it('returns warm when rotunda.glb has transferSize 0', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('content/rotunda.glb', 0, 10),
    ]);
    expect(marks.cacheState()).toBe('warm');
  });

  it('returns cold when rotunda.glb is not in entries', async () => {
    const marks = await loadMarks();
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      fakeResource('content/catalog.json', 500, 10),
    ]);
    expect(marks.cacheState()).toBe('cold');
  });
});

describe('scene-files scope', () => {
  it.each(['full', 'half'] as const)('reads %s encoded body bytes for the opening look on cold and warm loads', async (set) => {
    const marks = await loadMarks();
    const prefix = set === 'half' ? '/content/half/' : '/content/';
    const opening = 'looks/zoot-suit.glb';
    const bodySizes = [5_000_000, 1_000_000, 2_000_000];
    for (const cold of [false, true]) {
      const entries = ['rotunda.glb', 'plinth.glb', opening].map((file, index) =>
        fakeResource(`http://localhost${prefix}${file}?v=1`, cold ? bodySizes[index] + 300 : 0,
          20, bodySizes[index]));
      entries.push(fakeResource(`http://localhost${prefix}looks/wallis-dress.glb`, 999, 60, 900));
      entries.push(fakeResource('http://localhost/content/thumbs/zoot-suit.jpg', 500, 10, 200));
      entries.push({ ...fakeResource(`http://localhost${prefix}looks/later.glb`, 999, 40, 900), startTime: 30 });
      expect(marks.sceneFilesPayload(entries, 50)).toEqual({
        bytes: 8_000_000,
        budgetBytes: set === 'half' ? 6_000_000 : 10_000_000,
      });
      expect(marks.sceneFilesPayload(entries, null)).toBeNull();
      expect(marks.sceneFilesPayload(entries.slice(1), 50)).toBeNull();
    }
  });

  it('uses encoded rather than decoded body bytes when responses are compressed', async () => {
    const marks = await loadMarks();
    const entries = ['rotunda.glb', 'plinth.glb', 'looks/opening.glb'].map((file) => ({
      ...fakeResource(`http://localhost/content/${file}`, 500, 20, 200), decodedBodySize: 1_000,
    }));
    expect(marks.sceneFilesPayload(entries, 50)).toEqual({ bytes: 600, budgetBytes: 10_000_000 });
  });

  it('counts only resource entries, ignoring entries of other timing types', async () => {
    const marks = await loadMarks();
    const entries = [
      fakeResource('http://localhost/content/rotunda.glb', 500, 20, 5_000_000),
      fakeResource('http://localhost/content/plinth.glb', 300, 20, 1_000_000),
      { ...fakeResource('http://localhost/content/looks/opening.glb', 999, 20, 2_000_000),
        entryType: 'measure' },
    ];
    expect(marks.sceneFilesPayload(entries, 50)).toBeNull();
  });

  it('counts a scene file that completed exactly at the mark', async () => {
    const marks = await loadMarks();
    const entries = [
      fakeResource('http://localhost/content/rotunda.glb', 500, 40, 5_000_000),
      fakeResource('http://localhost/content/plinth.glb', 300, 45, 1_000_000),
      fakeResource('http://localhost/content/looks/opening.glb', 200, 50, 2_000_000),
    ];
    expect(marks.sceneFilesPayload(entries, 50)).toEqual({ bytes: 8_000_000, budgetBytes: 10_000_000 });
  });

  it('picks the earliest-started look fetch, not the first-listed', async () => {
    const marks = await loadMarks();
    const entries = [
      fakeResource('http://localhost/content/rotunda.glb', 500, 20, 5_000_000),
      fakeResource('http://localhost/content/plinth.glb', 300, 20, 1_000_000),
      { ...fakeResource('http://localhost/content/looks/second.glb', 999, 30, 700), startTime: 30 },
      { ...fakeResource('http://localhost/content/looks/opening.glb', 200, 25, 300), startTime: 10 },
    ];
    expect(marks.sceneFilesPayload(entries, 50))
      .toEqual({ bytes: 5_000_000 + 1_000_000 + 300, budgetBytes: 10_000_000 });
  });

  it('ignores a resource whose name is not a parseable URL instead of throwing', async () => {
    const marks = await loadMarks();
    const entries = [
      fakeResource('http://', 999, 10, 999),
      fakeResource('http://localhost/content/rotunda.glb', 500, 40, 5_000_000),
      fakeResource('http://localhost/content/plinth.glb', 300, 45, 1_000_000),
      fakeResource('http://localhost/content/looks/opening.glb', 200, 50, 2_000_000),
    ];
    // Names come from the browser's timing buffer; a malformed one must not break the snapshot.
    expect(marks.sceneFilesPayload(entries, 50)).toEqual({ bytes: 8_000_000, budgetBytes: 10_000_000 });
  });

  it('returns null when the plinth or the look response is missing', async () => {
    const marks = await loadMarks();
    const rotunda = fakeResource('http://localhost/content/rotunda.glb', 500, 20, 5_000_000);
    const plinth = fakeResource('http://localhost/content/plinth.glb', 300, 20, 1_000_000);
    const look = fakeResource('http://localhost/content/looks/opening.glb', 200, 20, 2_000_000);
    expect(marks.sceneFilesPayload([rotunda, look], 50)).toBeNull();
    expect(marks.sceneFilesPayload([rotunda, plinth], 50)).toBeNull();
  });
});
