// First-frame and payload measurement plus the proof snapshot assembly.

import type { FrameTimes } from './frametime';

const FIRST_FRAME_MARK = 'first-frame';

// Module state on purpose: the first frame happens exactly once per page load, and every later
// markFirstFrame call must be a no-op even if several code paths race to report it.
let firstFrameMarked = false;
let firstFrameTime: number | null = null;
const firstFrameListeners = new Set<() => void>();

/** Runs after the first scene draw, or immediately when its mark already exists. */
export function afterFirstFrame(callback: () => void, signal: AbortSignal): void {
  if (signal.aborted) return;
  if (firstFrameMs() !== null) {
    callback();
    return;
  }
  const cancel = (): void => { firstFrameListeners.delete(ready); };
  const ready = (): void => {
    firstFrameListeners.delete(ready);
    signal.removeEventListener('abort', cancel);
    if (!signal.aborted) callback();
  };
  firstFrameListeners.add(ready);
  signal.addEventListener('abort', cancel, { once: true });
}

// Content budgets use decimal MB and cover only rotunda, plinth and the opening look.
const SCENE_BUDGET_BYTES = { full: 10_000_000, half: 6_000_000 };
export interface SceneFilesPayload {
  bytes: number;
  budgetBytes: number;
}

/**
 * Identify the loaded set and opening look from responses completed by the scene mark.
 * encodedBodySize excludes headers and remains the body size on cold and warm loads. It equals
 * file bytes for the current uncompressed GLB responses; if a server compresses them, this row
 * shows compressed body bytes instead of the uncompressed file size.
 */
export function sceneFilesPayload(
  entries: PerformanceEntry[], limit: number | null,
): SceneFilesPayload | null {
  if (limit === null) return null;
  const completed = entries.filter((entry) => {
    const resource: { entryType: string; responseEnd?: number } = entry;
    return resource.entryType === 'resource' && typeof resource.responseEnd === 'number' &&
      resource.responseEnd <= limit;
  }).sort((a, b) => a.startTime - b.startTime).map((entry) => {
    let path = '';
    try { path = new URL(entry.name, 'http://localhost').pathname; } catch { /* Ignore invalid URLs. */ }
    const resource: { entryType: string; encodedBodySize?: number } = entry;
    return { path, bytes: resource.encodedBodySize };
  });
  for (const set of ['full', 'half'] as const) {
    const prefix = set === 'half' ? '/content/half/' : '/content/';
    const rotunda = completed.find((entry) => entry.path === `${prefix}rotunda.glb`);
    const plinth = completed.find((entry) => entry.path === `${prefix}plinth.glb`);
    const look = completed.find((entry) => entry.path.startsWith(`${prefix}looks/`) &&
      entry.path.endsWith('.glb'));
    if (typeof rotunda?.bytes !== 'number' || typeof plinth?.bytes !== 'number' ||
      typeof look?.bytes !== 'number') continue;
    return {
      bytes: rotunda.bytes + plinth.bytes + look.bytes,
      budgetBytes: SCENE_BUDGET_BYTES[set],
    };
  }
  return null;
}

/**
 * Records the User Timing mark 'first-frame' once. Later calls are ignored. The optional clock
 * exists so tests can pin the timestamp; without it the mark uses the real current time.
 */
export function markFirstFrame(now?: () => number): void {
  if (firstFrameMarked) {
    return;
  }
  firstFrameMarked = true;
  if (now === undefined) {
    performance.mark(FIRST_FRAME_MARK);
  } else {
    performance.mark(FIRST_FRAME_MARK, { startTime: now() });
  }
  for (const ready of [...firstFrameListeners]) ready();
}

/**
 * Milliseconds from navigation start to the first frame, null before the mark exists.
 * PerformanceEntry.startTime is already relative to timeOrigin (navigation start), so no
 * subtraction is needed here.
 */
export function firstFrameMs(): number | null {
  if (firstFrameTime !== null) return firstFrameTime;
  for (const entry of performance.getEntriesByName(FIRST_FRAME_MARK)) {
    if (entry.entryType === 'mark') {
      firstFrameTime = entry.startTime;
      return firstFrameTime;
    }
  }
  return null;
}

/**
 * Sum of transferSize over Resource Timing entries. Entries with transferSize 0 (cache hits and
 * cross-origin responses without Timing-Allow-Origin) count as 0; that is the honest number and
 * expected, not a bug. With untilFirstFrame true, only entries that ended at or before the
 * first-frame mark are summed, and before that mark exists nothing can have ended before it,
 * so the result is 0.
 */
export function payloadBytes(untilFirstFrame?: boolean): number {
  const limit = untilFirstFrame === true ? firstFrameMs() : null;
  if (limit === null && untilFirstFrame === true) {
    return 0;
  }
  return sumPayload(performance.getEntriesByType('resource'), limit);
}

function sumPayload(entries: PerformanceEntry[], limit: number | null): number {
  let total = 0;
  for (const entry of entries) {
    // getEntriesByType is typed as PerformanceEntry[]; Resource Timing fields are read through
    // optional structural properties instead of a cast. entryType is named as well because the
    // compiler rejects assignments between types that share no property at all.
    const resource: { entryType: string; transferSize?: number; responseEnd?: number } = entry;
    if (limit !== null) {
      const responseEnd = resource.responseEnd;
      if (typeof responseEnd !== 'number' || responseEnd > limit) {
        continue;
      }
    }
    const size = resource.transferSize;
    if (typeof size === 'number') {
      total += size;
    }
  }
  return total;
}

/**
 * Reads whether the rotunda asset arrived cold (transferSize > 0) or warm (from cache, transferSize 0).
 * With no rotunda entry at all the answer is 'cold': the panel is read from the first frame on, and
 * before the fetch has been observed nothing has proved a cache hit. Reporting 'warm' there would
 * claim a hit that may never have happened, and the load number beside it would contradict it.
 */
export function cacheState(): 'cold' | 'warm' {
  return resourceCacheState(performance.getEntriesByType('resource'));
}

function resourceCacheState(entries: PerformanceEntry[]): 'cold' | 'warm' {
  for (const entry of entries) {
    const resource: { name?: string; transferSize?: number } = entry;
    if (typeof resource.name === 'string' && resource.name.includes('rotunda.glb')) {
      if (typeof resource.transferSize === 'number' && resource.transferSize > 0) {
        return 'cold';
      }
      return 'warm';
    }
  }
  return 'cold';
}

/**
 * Returns the duration of the most recent 'look-switch' performance measure entry, or null if none.
 */
export function latestLookSwitchMs(): number | null {
  if (typeof performance === 'undefined' || typeof performance.getEntriesByName !== 'function') {
    return null;
  }
  const entries = performance.getEntriesByName('look-switch');
  if (entries.length === 0) {
    return null;
  }
  return entries[entries.length - 1].duration;
}

export interface ProofSnapshot {
  loadMs: number | null;
  payloadBytes: number;
  /**
   * The second payload number the definition asks for: every byte transferred so far, so a client
   * sees what the load cost and what the whole session cost once the looks have been fetched.
   */
  payloadNowBytes: number;
  sceneFiles?: SceneFilesPayload | null;
  drawCalls: number;
  triangles: number;
  backend: string;
  tier: string;
  pixelRatio: number;
  renderScale: number;
  gpuName: string;
  frameP50Ms: number;
  frameP95Ms: number;
  lookSwitchMs: number | null;
  gpu: { p50: number | null; p95: number | null; available: boolean };
  post: string;
  /**
   * The canvas's committed data-governor status tokens ('off' when no governor runs this page).
   * Optional so older snapshot builders keep compiling; the composition root always passes it.
   */
  governor?: string;
  /** The canvas's committed, capped data-governor-log JSON; '' when no governor runs. */
  governorLog?: string;
  cacheState: 'cold' | 'warm';
}

export interface SnapshotInput {
  /**
   * Structural stand-in for three.js renderer.info, which this module never imports. The field is
   * WebGPURenderer's `render.drawCalls`, the draw count of the current frame; `render.calls` on that
   * renderer counts render() invocations since start and is not a per-frame number.
   */
  info: { render: { drawCalls: number; triangles: number } };
  backend: string;
  tier: string;
  pixelRatio: number;
  renderScale: number;
  gpuName: string;
  frames: FrameTimes;
  gpu: { p50: number | null; p95: number | null; available: boolean };
  lookSwitchMs: number | null;
  /**
   * The canvas's data-post value. Required, and passed in by the composition root: this module
   * owns no element, and a DOM query here would read a second source for a number the caller
   * already holds, which is how the panel and the e2e suite drift apart.
   */
  post: string;
  /** The canvas's committed data-governor tokens, the same bridge the panel and e2e read. */
  governor?: string;
  /** The canvas's committed, capped data-governor-log JSON. */
  governorLog?: string;
  cacheState?: 'cold' | 'warm';
}

/**
 * Assembles the panel payload from live inputs plus the marks module. payloadBytes is taken
 * until the first frame on purpose: it is the payload of the load, the number that pairs with
 * loadMs, and it stops growing as the showroom streams in later assets. payloadNowBytes is the
 * running total beside it.
 */
export function snapshot(input: SnapshotInput): ProofSnapshot {
  const loadMs = firstFrameMs();
  // Read the current buffer once. Late entries and buffer clears must still affect both sums
  // and the first matching rotunda entry; those answers are not immutable like the mark.
  const resources = performance.getEntriesByType('resource');
  return {
    loadMs,
    payloadBytes: loadMs === null ? 0 : sumPayload(resources, loadMs),
    payloadNowBytes: sumPayload(resources, null),
    sceneFiles: sceneFilesPayload(resources, loadMs),
    drawCalls: input.info.render.drawCalls,
    triangles: input.info.render.triangles,
    backend: input.backend,
    tier: input.tier,
    pixelRatio: input.pixelRatio,
    renderScale: input.renderScale,
    gpuName: input.gpuName,
    frameP50Ms: input.frames.p50(),
    frameP95Ms: input.frames.p95(),
    lookSwitchMs: input.lookSwitchMs,
    gpu: input.gpu,
    post: input.post,
    governor: input.governor ?? 'off',
    governorLog: input.governorLog ?? '',
    cacheState: input.cacheState ?? resourceCacheState(resources),
  };
}
