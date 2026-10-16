// Truthful first-frame progress for the entry lobby: the byte total and file count of the
// assets the first frame waits for, read from Resource Timing and matched against the
// resolved content URLs. Depends only on the catalog and loading modules; the lobby turns
// readings into the bar and status text.

import { findLook } from '../../catalog/bootstrap';
import { contentUrl, loadCatalog } from '../../catalog/catalog';
import { expectedBytes } from '../../loading/progress';
import type { ManifestFile, ResourceEntry } from '../../loading/progress';

export interface ProgressReading {
  received: number;
  expected: number;
  ended: number;
  totalFiles: number;
  fromCache: boolean;
}

/**
 * Refresh cadence of the lobby progress readout in trackFirstFrameProgress(): each tick
 * re-reads Resource Timing and pushes a reading, alongside the PerformanceObserver's
 * resource events.
 */
const READOUT_REFRESH_INTERVAL_MS = 250;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readManifestFiles(json: unknown, setName: string): Record<string, ManifestFile> | null {
  if (!isRecord(json) || !isRecord(json['sets'])) {
    return null;
  }
  const set = json['sets'][setName];
  if (!isRecord(set) || !isRecord(set['files'])) {
    return null;
  }
  const files: Record<string, ManifestFile> = {};
  for (const [name, value] of Object.entries(set['files'])) {
    if (isRecord(value) && typeof value['bytes'] === 'number' && Number.isFinite(value['bytes'])) {
      files[name] = { bytes: value['bytes'] };
    }
  }
  return files;
}

function resourceUrl(name: string): string {
  try {
    return new URL(name, window.location.href).href;
  } catch {
    // An unresolvable name matches no expected path and drops only from the lobby's informational readout.
    return name;
  }
}

/**
 * `countEnvironment` is true only under the ?sky=hdr diagnostic: the default sky is generated in
 * memory and requests no environment file. `wantedLook` is the raw ?look= value, resolved by the
 * catalogue's one look rule: the expected bytes, paths and file count follow the look the page's
 * picker shows first, so a deep link is counted by the look it names instead of the first look.
 */
export function trackFirstFrameProgress(
  contentBase: string,
  onProgress: (reading: ProgressReading) => void,
  countEnvironment = false,
  wantedLook: string | null = null,
): () => void {
  let expected = 0;
  let expectedPaths: string[] = [];
  let fromCache = false;
  let stopped = false;

  function contentEntries(): ResourceEntry[] {
    const readings: ResourceEntry[] = [];
    if (typeof performance === 'undefined' || !performance.getEntriesByType) {
      return readings;
    }
    for (const measured of performance.getEntriesByType('resource')) {
      const resource: {
        entryType?: string;
        name?: string;
        transferSize?: number;
        responseEnd?: number;
      } = measured;
      if (resource.entryType !== 'resource' || typeof resource.name !== 'string') {
        continue;
      }
      readings.push({
        name: resource.name,
        transferSize: typeof resource.transferSize === 'number' ? resource.transferSize : 0,
        responseEnd: typeof resource.responseEnd === 'number' ? resource.responseEnd : 0,
      });
    }
    return readings;
  }

  function countEnded(mine: ResourceEntry[]): number {
    const arrived = new Set(mine.map((one) => resourceUrl(one.name)));
    return expectedPaths.filter((path) => arrived.has(path)).length;
  }

  function update(): void {
    if (stopped) {
      return;
    }
    const mine = contentEntries().filter((one) => expectedPaths.includes(resourceUrl(one.name)));
    const received = mine.reduce((total, entry) => total + entry.transferSize, 0);
    if (!fromCache && mine.length > 0) {
      const first = mine.reduce((left, right) => (right.responseEnd < left.responseEnd ? right : left));
      if (first.transferSize === 0) {
        fromCache = true;
      }
    }
    const ended = countEnded(mine);
    onProgress({
      received,
      expected,
      ended,
      totalFiles: expectedPaths.length,
      fromCache,
    });
  }

  let observer: PerformanceObserver | null = null;
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      observer = new PerformanceObserver(() => {
        update();
      });
      observer.observe({ type: 'resource', buffered: true });
    } catch {
      // PerformanceObserver type resource may not be supported in some environments
    }
  }

  const ticker = window.setInterval(update, READOUT_REFRESH_INTERVAL_MS);

  void (async () => {
    try {
      // One manifest document at the content root holds both sets (sets.full, sets.half); the
      // half folder ships no manifest of its own, so the document is read from the root and the
      // set is picked by name below.
      const manifestBase = contentBase.endsWith('/half')
        ? contentBase.slice(0, -'/half'.length)
        : contentBase;
      const [manifestResponse, catalog] = await Promise.all([
        fetch(contentUrl(manifestBase, 'manifest.json')),
        loadCatalog(contentUrl(contentBase, 'catalog.json')),
      ]);
      if (manifestResponse.ok) {
        const setName = contentBase.endsWith('/half') ? 'half' : 'full';
        const files = readManifestFiles(await manifestResponse.json(), setName);
        const firstLook = findLook(catalog.looks, wantedLook).file;
        const environmentFile = countEnvironment ? catalog.environment.file : null;
        expected = files === null ? 0 : expectedBytes(files, firstLook, environmentFile);
        expectedPaths = [
          catalog.rotunda.file,
          catalog.plinth.file,
          firstLook,
        ].map((file) => resourceUrl(contentUrl(contentBase, file)));
        if (environmentFile !== null) {
          expectedPaths.push(resourceUrl(contentUrl(manifestBase, environmentFile)));
        }
        update();
      }
    } catch (err) {
      console.warn('[archviz] progress tracker could not load manifest', err);
    }
  })();

  return () => {
    stopped = true;
    observer?.disconnect();
    window.clearInterval(ticker);
  };
}
