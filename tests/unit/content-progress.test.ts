// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ProgressReading } from '../../src/ui/entry-lobby';

const origin = 'https://static.example.invalid';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); vi.useRealTimers(); });

// The shipped catalogue and manifest, served through a stubbed fetch, so the totals below are
// the real first-frame files of the full set and the half set.
const catalogText = readFileSync('public/content/catalog.json', 'utf8');
const halfCatalogText = readFileSync('public/content/half/catalog.json', 'utf8');
const manifestText = readFileSync('public/content/manifest.json', 'utf8');
const catalogJson = JSON.parse(catalogText) as {
  rotunda: { file: string };
  plinth: { file: string };
  looks: { id: string; file: string }[];
};

/**
 * An observer that records its callback and never fires on its own, so a reading can only come
 * from the path under test: the ticker, the manifest landing, or the callback itself.
 */
function quietObserver(): { callbacks: Array<() => void> } {
  const callbacks: Array<() => void> = [];
  class Observer {
    constructor(callback: () => void) {
      callbacks.push(callback);
    }

    observe(): void {}

    disconnect(): void {}
  }
  vi.stubGlobal('PerformanceObserver', Observer);
  return { callbacks };
}

/** Drains the microtask queue far enough for a resolved fetch and its JSON body to settle. */
async function settle(): Promise<void> {
  for (let step = 0; step < 20; step += 1) {
    await Promise.resolve();
  }
}

function serveCatalogAndManifest(): void {
  vi.stubGlobal('fetch', (url: string) =>
    Promise.resolve(new Response(url.endsWith('manifest.json') ? manifestText : catalogText)));
}

function resourceEntries(
  sizes: Array<{ file: string; transferSize: number; responseEnd?: number }>,
  base = '/content/',
): void {
  const entries = sizes.map((one) => ({
    entryType: 'resource',
    name: base + one.file,
    transferSize: one.transferSize,
    responseEnd: one.responseEnd ?? 1,
  }));
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue(entries as unknown as PerformanceEntry[]);
}

it.each([false, true])('tracks resolved remote scene URLs including the shared HDR (half=%s)', async (half) => {
  const base = half ? 'half/' : '';
  const scenePaths = [`${base}rotunda.glb`, `${base}plinth.glb`, `${base}looks/wallis-dress.glb`,
    'env/school-field-cloudy-1k.hdr'];
  const paths = ['manifest.json', `${base}catalog.json`, ...scenePaths,
    'basis/basis_transcoder.js', 'basis/basis_transcoder.wasm'];
  const manifest = { origin, files: paths.map((path, index) => {
    const sha256 = index.toString(16).padStart(64, '0');
    const key = path.startsWith('basis/') ? `content/${path}` : `content/${sha256}.${path.split('.').pop()}`;
    return { path, sha256, bytes: 100, key, url: `${origin}/${key}` };
  }) };
  vi.stubGlobal('__CONTENT_ORIGIN__', origin);
  vi.stubGlobal('__CONTENT_MANIFEST__', manifest);
  vi.resetModules();
  const { trackFirstFrameProgress } = await import('../../src/ui/entry-lobby/progress');
  const urls = new Map(manifest.files.map((entry) => [entry.path, entry.url]));
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === urls.get('manifest.json')) return new Response(readFileSync('public/content/manifest.json'));
    if (url === urls.get(`${base}catalog.json`)) return new Response(readFileSync('public/content/catalog.json'));
    throw new Error('unexpected request: ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
  const entries = scenePaths.map((path) => ({
    entryType: 'resource', name: urls.get(path), transferSize: 100, responseEnd: 10,
  }));
  // Another host with the same object pathname must not enter the count.
  entries.push({ ...entries[0], name: entries[0].name?.replace(origin, 'https://other.example.invalid') });
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue(entries as unknown as PerformanceEntry[]);
  const readings: ProgressReading[] = [];
  const stop = trackFirstFrameProgress(half ? '/content/half' : '/content', (reading) => readings.push(reading), true);
  try {
    await vi.waitFor(() => expect(readings.at(-1)?.ended).toBe(4));
    expect(readings.at(-1)).toMatchObject({ received: 400, totalFiles: 4, fromCache: false });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      urls.get('manifest.json'), urls.get(`${base}catalog.json`),
    ]);
  } finally { stop(); }
});

// The phone build must promise the bytes it will actually fetch: the half set has its own,
// smaller files, so the readout would overshoot all visit long if it read the full sizes.
it('reads the half set its own sizes from the root manifest', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/content/manifest.json') return new Response(manifestText);
    if (url === '/content/half/catalog.json') return new Response(halfCatalogText);
    throw new Error('unexpected request: ' + url);
  });
  vi.stubGlobal('fetch', fetchMock);
  const manifest = JSON.parse(manifestText) as {
    sets: Record<'full' | 'half', { files: Record<string, { bytes: number }> }>;
  };
  const halfCatalog = JSON.parse(halfCatalogText) as typeof catalogJson;
  const halfFiles = [halfCatalog.rotunda.file, halfCatalog.plinth.file, halfCatalog.looks[0].file];
  const halfBytes = halfFiles.map((file) => manifest.sets.half.files[file].bytes);
  const fullBytes = [
    catalogJson.rotunda.file, catalogJson.plinth.file, catalogJson.looks[0].file,
  ].map((file) => manifest.sets.full.files[file].bytes);
  resourceEntries(
    halfFiles.map((file, index) => ({ file, transferSize: halfBytes[index] })),
    '/content/half/',
  );
  const readings: ProgressReading[] = [];
  const { trackFirstFrameProgress } = await import('../../src/ui/entry-lobby/progress');
  const stop = trackFirstFrameProgress('/content/half', (reading) => readings.push(reading));
  try {
    await vi.waitFor(() => expect(readings.some((one) => one.expected > 0)).toBe(true));
    const reading = readings.find((one) => one.expected > 0)!;
    expect(reading.expected).toBe(halfBytes[0] + halfBytes[1] + halfBytes[2]);
    expect(reading.expected).not.toBe(fullBytes[0] + fullBytes[1] + fullBytes[2]);
    expect(reading).toMatchObject({ received: reading.expected, ended: 3, totalFiles: 3 });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      '/content/manifest.json', '/content/half/catalog.json',
    ]);
  } finally { stop(); }
});

// Resource Timing reports request names as absolute URLs, while the catalogue resolves to
// content-root-relative paths; the readout only matches if both sides are normalised.
it('matches the absolute names Resource Timing reports against the content paths', async () => {
  serveCatalogAndManifest();
  const entries = [catalogJson.rotunda.file, catalogJson.plinth.file, catalogJson.looks[0].file]
    .map((file, index) => ({
      entryType: 'resource',
      name: new URL('/content/' + file, window.location.href).href,
      transferSize: (index + 1) * 100,
      responseEnd: 1,
    }));
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue(entries as unknown as PerformanceEntry[]);
  const readings: ProgressReading[] = [];
  const { trackFirstFrameProgress } = await import('../../src/ui/entry-lobby/progress');
  const stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
  try {
    await vi.waitFor(() => expect(readings.some((one) => one.expected > 0)).toBe(true));
    expect(readings.find((one) => one.expected > 0)).toMatchObject(
      { received: 600, ended: 3, totalFiles: 3, fromCache: false },
    );
  } finally { stop(); }
});

// The readout is informational: one malformed name in the timing buffer, which the URL parser
// rejects, must cost the tracker neither its readings nor its silence.
it('drops a resource entry whose name is no valid URL and keeps reading', async () => {
  serveCatalogAndManifest();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const entries = [
    { entryType: 'resource', name: '/content/' + catalogJson.rotunda.file, transferSize: 10, responseEnd: 1 },
    { entryType: 'resource', name: 'https://[', transferSize: 500, responseEnd: 1 },
  ];
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue(entries as unknown as PerformanceEntry[]);
  const readings: ProgressReading[] = [];
  const { trackFirstFrameProgress } = await import('../../src/ui/entry-lobby/progress');
  const stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
  try {
    await vi.waitFor(() => expect(readings.some((one) => one.expected > 0)).toBe(true));
    expect(readings.find((one) => one.expected > 0)).toMatchObject({ received: 10, ended: 1 });
    expect(warn).not.toHaveBeenCalled();
  } finally { stop(); }
});

it('counts only string-named resource entries', async () => {
  serveCatalogAndManifest();
  const entries = [
    { entryType: 'resource', name: '/content/' + catalogJson.rotunda.file, transferSize: 10, responseEnd: 1 },
    { entryType: 'paint', name: '/content/' + catalogJson.plinth.file, transferSize: 999, responseEnd: 1 },
    {
      entryType: 'resource',
      name: { toString: () => '/content/' + catalogJson.looks[0].file },
      transferSize: 888,
      responseEnd: 1,
    },
  ];
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue(entries as unknown as PerformanceEntry[]);
  const readings: ProgressReading[] = [];
  const { trackFirstFrameProgress } = await import('../../src/ui/entry-lobby/progress');
  const stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
  try {
    await vi.waitFor(() => expect(readings.some((one) => one.expected > 0)).toBe(true));
    expect(readings.find((one) => one.expected > 0)).toMatchObject(
      { received: 10, ended: 1, totalFiles: 3 },
    );
  } finally { stop(); }
});

it('counts a missing transfer size as zero received bytes', async () => {
  serveCatalogAndManifest();
  resourceEntries([
    { file: catalogJson.rotunda.file, transferSize: 'large' as unknown as number },
    { file: catalogJson.plinth.file, transferSize: 20 },
    { file: catalogJson.looks[0].file, transferSize: 30 },
  ]);
  const readings: ProgressReading[] = [];
  const { trackFirstFrameProgress } = await import('../../src/ui/entry-lobby/progress');
  const stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
  try {
    await vi.waitFor(() => expect(readings.some((one) => one.expected > 0)).toBe(true));
    expect(readings.find((one) => one.expected > 0)).toMatchObject({ received: 50, ended: 3 });
  } finally { stop(); }
});

// The cache verdict reads the earliest response end, and a timing entry without one counts as
// the very start: the greeting must not wait for a byte count that a cache never reports.
it('probes the cache with the earliest response end, missing values at zero', async () => {
  serveCatalogAndManifest();
  resourceEntries([
    { file: catalogJson.looks[0].file, transferSize: 100, responseEnd: 5 },
    { file: catalogJson.rotunda.file, transferSize: 0, responseEnd: 'later' as unknown as number },
    { file: catalogJson.plinth.file, transferSize: 30, responseEnd: 7 },
  ]);
  const readings: ProgressReading[] = [];
  const { trackFirstFrameProgress } = await import('../../src/ui/entry-lobby/progress');
  const stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
  try {
    await vi.waitFor(() => expect(readings.some((one) => one.expected > 0)).toBe(true));
    expect(readings.find((one) => one.expected > 0)).toMatchObject(
      { received: 130, ended: 3, fromCache: true },
    );
  } finally { stop(); }
});

it('counts one arrival per expected file already in, never ahead of them', async () => {
  serveCatalogAndManifest();
  resourceEntries([
    { file: catalogJson.rotunda.file, transferSize: 10 },
    { file: catalogJson.plinth.file, transferSize: 20 },
  ]);
  const readings: ProgressReading[] = [];
  const { trackFirstFrameProgress } = await import('../../src/ui/entry-lobby/progress');
  const stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
  try {
    await vi.waitFor(() => expect(readings.some((one) => one.totalFiles === 3)).toBe(true));
    expect(readings.find((one) => one.totalFiles === 3)).toMatchObject(
      { received: 30, ended: 2, totalFiles: 3 },
    );
  } finally { stop(); }
});

it('greets a cache visit from the first cached file alone', async () => {
  serveCatalogAndManifest();
  resourceEntries([{ file: catalogJson.rotunda.file, transferSize: 0 }]);
  const readings: ProgressReading[] = [];
  const { trackFirstFrameProgress } = await import('../../src/ui/entry-lobby/progress');
  const stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
  try {
    await vi.waitFor(() => expect(readings.some((one) => one.totalFiles === 3)).toBe(true));
    expect(readings.find((one) => one.totalFiles === 3)).toMatchObject(
      { received: 0, ended: 1, fromCache: true },
    );
  } finally { stop(); }
});

it.each([
  ['undefined', undefined],
  ['present without getEntriesByType', {}],
])('keeps publishing readings with the performance API %s', async (_label, broken) => {
  vi.stubGlobal('performance', broken);
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
  const readings: ProgressReading[] = [];
  const { trackFirstFrameProgress } = await import('../../src/ui/entry-lobby/progress');
  const stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
  try {
    await new Promise((resolve) => { setTimeout(resolve, 400); });
    expect(readings.length).toBeGreaterThanOrEqual(1);
    for (const reading of readings) {
      expect(reading).toEqual({ received: 0, expected: 0, ended: 0, totalFiles: 0, fromCache: false });
    }
  } finally { stop(); }
});

it('stops publishing when stopped, even if the manifest lands afterwards', async () => {
  vi.useFakeTimers();
  try {
    quietObserver();
    let resolveManifest!: (response: Response) => void;
    let resolveCatalog!: (response: Response) => void;
    vi.stubGlobal('fetch', (url: string) => url.endsWith('manifest.json')
      ? new Promise<Response>((resolve) => { resolveManifest = resolve; })
      : new Promise<Response>((resolve) => { resolveCatalog = resolve; }));
    const readings: ProgressReading[] = [];
    const { trackFirstFrameProgress } = await import('../../src/ui/entry-lobby/progress');
    const stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(readings).toHaveLength(1);
      stop();
      resolveManifest(new Response(manifestText));
      resolveCatalog(new Response(catalogText));
      await settle();
      await vi.advanceTimersByTimeAsync(250);
      expect(readings).toHaveLength(1);
      expect(readings.every((reading) => reading.expected === 0)).toBe(true);
    } finally {
      stop();
    }
  } finally {
    vi.useRealTimers();
  }
});

// A visitor watching the bar must not wait a full tick after the sizes are known.
it('publishes as soon as the manifest lands, before the first tick', async () => {
  vi.useFakeTimers();
  try {
    quietObserver();
    serveCatalogAndManifest();
    const readings: ProgressReading[] = [];
    const { trackFirstFrameProgress } = await import('../../src/ui/entry-lobby/progress');
    const stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
    try {
      await settle();
      expect(readings.some((reading) => reading.expected > 0)).toBe(true);
      // The ticker has not fired yet: the reading came from the manifest landing itself.
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      stop();
    }
  } finally {
    vi.useRealTimers();
  }
});

it('refreshes the readout when a resource event arrives between ticks', async () => {
  vi.useFakeTimers();
  try {
    const { callbacks } = quietObserver();
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
    const readings: ProgressReading[] = [];
    const { trackFirstFrameProgress } = await import('../../src/ui/entry-lobby/progress');
    const stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
    try {
      expect(readings).toHaveLength(0);
      callbacks[0]!();
      expect(readings).toHaveLength(1);
      expect(readings[0]).toEqual({ received: 0, expected: 0, ended: 0, totalFiles: 0, fromCache: false });
    } finally {
      stop();
    }
  } finally {
    vi.useRealTimers();
  }
});

it('keeps tracking when the observer cannot observe resource entries', async () => {
  vi.useFakeTimers();
  try {
    class ThrowingObserver {
      constructor(callback: () => void) {
        void callback;
      }

      observe(): void {
        throw new Error('resource entries unsupported here');
      }

      disconnect(): void {}
    }
    vi.stubGlobal('PerformanceObserver', ThrowingObserver);
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
    const readings: ProgressReading[] = [];
    const { trackFirstFrameProgress } = await import('../../src/ui/entry-lobby/progress');
    let stop: () => void = () => {};
    expect(() => {
      stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading));
    }).not.toThrow();
    try {
      await vi.advanceTimersByTimeAsync(250);
      expect(readings).toHaveLength(1);
    } finally {
      stop();
    }
  } finally {
    vi.useRealTimers();
  }
});

it('disconnects its resource observer and clears its interval when stopped', async () => {
  vi.useFakeTimers();
  const observers: Observer[] = [];
  class Observer {
    observe = vi.fn();
    disconnect = vi.fn();

    constructor() {
      observers.push(this);
    }
  }
  vi.stubGlobal('PerformanceObserver', Observer);
  vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
  const { trackFirstFrameProgress } = await import('../../src/ui/entry-lobby/progress');
  expect(vi.getTimerCount()).toBe(0);
  const stop = trackFirstFrameProgress('/content', () => {});
  try {
    expect(observers).toHaveLength(1);
    const observer = observers[0]!;
    expect(observer.observe).toHaveBeenCalledWith({ type: 'resource', buffered: true });
    expect(observer.disconnect).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    stop();

    expect(observer.disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    stop();
  }
});

// The lobby renders on demand; a readout interval left running after the load would keep the
// page awake for nothing.
it('leaves no ticker running after it is stopped', async () => {
  vi.useFakeTimers();
  try {
    quietObserver();
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
    const { trackFirstFrameProgress } = await import('../../src/ui/entry-lobby/progress');
    const stop = trackFirstFrameProgress('/content', () => {});
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
