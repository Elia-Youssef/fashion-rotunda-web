// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ProgressReading } from '../../src/ui/entry-lobby';

const origin = 'https://static.example.invalid';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

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
