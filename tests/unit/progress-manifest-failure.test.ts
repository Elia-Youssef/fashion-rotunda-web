// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { trackFirstFrameProgress } from '../../src/ui/entry-lobby/progress';
import type { ProgressReading } from '../../src/ui/entry-lobby/progress';

// Contract for a failed progress manifest: the tracker warns once in the console with its
// standing text and the cause attached, every reading stays at zero so the lobby bar stays
// empty (setProgress maps an expected of 0 to a bar value of 0), and the failure neither holds
// back the catalogue request nor escapes or silences the tracker. The manifest only feeds the
// readout, so the load itself must go on.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('warns once and stays at zero when the progress manifest fails', async () => {
  const manifestError = new TypeError('the progress manifest request failed');
  const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === '/content/manifest.json') {
      throw manifestError;
    }
    if (url === '/content/catalog.json') {
      return new Response(readFileSync('public/content/catalog.json'));
    }
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const readings: ProgressReading[] = [];
  const stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
  try {
    // Both requests go out together: the manifest failure must not hold the catalogue back.
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      '/content/manifest.json',
      '/content/catalog.json',
    ]);

    // The failure surfaces once, with the text a reader greps for and the cause attached.
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(warn.mock.calls[0]?.[0]).toBe('[archviz] progress tracker could not load manifest');
    expect(warn.mock.calls[0]?.[1]).toBe(manifestError);

    // The bar stays empty: every reading carries no expected bytes, no files and no received
    // bytes. The ticker keeps the readout live without repeating the warning.
    await vi.waitFor(() => expect(readings.length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    for (const reading of readings) {
      expect(reading.expected).toBe(0);
      expect(reading.totalFiles).toBe(0);
      expect(reading.received).toBe(0);
    }
    expect(warn).toHaveBeenCalledTimes(1);

    // The caller still owns the tracker: stopping it after the failure must not throw and
    // must end the readings.
    expect(() => stop()).not.toThrow();
    const settled = readings.length;
    await new Promise((resolve) => { setTimeout(resolve, 400); });
    expect(readings.length).toBe(settled);
  } finally {
    stop();
  }
});
