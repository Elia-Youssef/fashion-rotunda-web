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
//
// A manifest that answers not ok, or whose body carries no readable sizes, is held to a
// neighbouring rule: it is not a failure at all, so nothing warns; the readout carries no byte
// total (expected stays 0) while still counting the first-frame files it expects to arrive.
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const catalogText = readFileSync('public/content/catalog.json', 'utf8');
const catalogJson = JSON.parse(catalogText) as {
  rotunda: { file: string };
  plinth: { file: string };
  looks: { id: string; file: string }[];
};

/** Serves the given manifest body beside the shipped catalogue, with the three first-frame
 *  files already in the timing buffer at 10, 20 and 30 bytes. */
function serveManifest(body: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === '/content/manifest.json') return new Response(body);
    if (url === '/content/catalog.json') return new Response(catalogText);
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const entries = [catalogJson.rotunda.file, catalogJson.plinth.file, catalogJson.looks[0].file]
    .map((file, index) => ({
      entryType: 'resource', name: '/content/' + file,
      transferSize: (index + 1) * 10, responseEnd: 1,
    }));
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue(entries as unknown as PerformanceEntry[]);
  return fetchMock;
}

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

it.each([
  ['a JSON null document', 'null'],
  ['no sets map', '{"sets":null}'],
  ['a missing named set', '{"sets":{"full":null}}'],
  ['no files map', '{"sets":{"full":{"files":null}}}'],
])('counts the first-frame files without sizes when the manifest is %s', async (_label, body) => {
  serveManifest(body);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const readings: ProgressReading[] = [];
  const stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
  try {
    await vi.waitFor(() => expect(readings.some((one) => one.totalFiles === 3)).toBe(true), { timeout: 2000 });
    expect(readings.at(-1)).toEqual(
      { received: 60, expected: 0, ended: 3, totalFiles: 3, fromCache: false },
    );
    expect(warn).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

it('drops manifest entries whose size is not a finite number', async () => {
  const files = `{"${catalogJson.rotunda.file}":{"bytes":111},` +
    `"${catalogJson.plinth.file}":{"bytes":"123"},` +
    `"${catalogJson.looks[0].file}":{"bytes":1e999}}`;
  serveManifest(`{"sets":{"full":{"files":${files}}}}`);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const readings: ProgressReading[] = [];
  const stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
  try {
    await vi.waitFor(() => expect(readings.some((one) => one.totalFiles === 3)).toBe(true), { timeout: 2000 });
    expect(readings.at(-1)).toEqual(
      { received: 60, expected: 111, ended: 3, totalFiles: 3, fromCache: false },
    );
    expect(warn).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

it('skips a null manifest entry without failing the readout', async () => {
  const files = `{"${catalogJson.rotunda.file}":null,` +
    `"${catalogJson.plinth.file}":{"bytes":222},` +
    `"${catalogJson.looks[0].file}":{"bytes":333}}`;
  serveManifest(`{"sets":{"full":{"files":${files}}}}`);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const readings: ProgressReading[] = [];
  const stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
  try {
    await vi.waitFor(() => expect(readings.some((one) => one.expected > 0)).toBe(true), { timeout: 2000 });
    expect(readings.find((one) => one.expected > 0)).toEqual(
      { received: 60, expected: 555, ended: 3, totalFiles: 3, fromCache: false },
    );
    expect(warn).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});

it('stays at zero without a warning when the manifest answers not ok', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url === '/content/manifest.json') return new Response('missing', { status: 404 });
    if (url === '/content/catalog.json') return new Response(catalogText);
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const readings: ProgressReading[] = [];
  const stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
  try {
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      '/content/manifest.json',
      '/content/catalog.json',
    ]);
    await vi.waitFor(() => expect(readings.length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    for (const reading of readings) {
      expect(reading).toEqual({ received: 0, expected: 0, ended: 0, totalFiles: 0, fromCache: false });
    }
    expect(warn).not.toHaveBeenCalled();
  } finally {
    stop();
  }
});
