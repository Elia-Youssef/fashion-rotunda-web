// Goal G0.4: first-frame and payload measurement plus the proof snapshot assembly.

import type { FrameTimes } from './frametime';

const FIRST_FRAME_MARK = 'first-frame';

// Module state on purpose: the first frame happens exactly once per page load, and every later
// markFirstFrame call must be a no-op even if several code paths race to report it.
let firstFrameMarked = false;

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
}

/**
 * Milliseconds from navigation start to the first frame, null before the mark exists.
 * PerformanceEntry.startTime is already relative to timeOrigin (navigation start), so no
 * subtraction is needed here.
 */
export function firstFrameMs(): number | null {
  const marks = performance
    .getEntriesByName(FIRST_FRAME_MARK)
    .filter((entry): entry is PerformanceMark => entry.entryType === 'mark');
  if (marks.length === 0) {
    return null;
  }
  return marks[0].startTime;
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
  let total = 0;
  for (const entry of performance.getEntriesByType('resource')) {
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

export interface ProofSnapshot {
  loadMs: number | null;
  payloadBytes: number;
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
  lookSwitchMs?: number | null;
}

/**
 * Assembles the panel payload from live inputs plus the marks module. payloadBytes is taken
 * until the first frame on purpose: it is the payload of the load, the number that pairs with
 * loadMs, and it stops growing as the showroom streams in later assets.
 */
export function snapshot(input: SnapshotInput): ProofSnapshot {
  return {
    loadMs: firstFrameMs(),
    payloadBytes: payloadBytes(true),
    drawCalls: input.info.render.drawCalls,
    triangles: input.info.render.triangles,
    backend: input.backend,
    tier: input.tier,
    pixelRatio: input.pixelRatio,
    renderScale: input.renderScale,
    gpuName: input.gpuName,
    frameP50Ms: input.frames.p50(),
    frameP95Ms: input.frames.p95(),
    lookSwitchMs: input.lookSwitchMs ?? null,
  };
}
