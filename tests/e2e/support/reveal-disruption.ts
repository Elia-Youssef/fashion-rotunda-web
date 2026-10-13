import type { TransitionDisruption, TransitionStableFrame } from '../../../src/ui/scene-reveal';

/** Validates the counter captured immediately after the real lifecycle handler, not a later poll. */
export function assertDisruptionReset(record: TransitionDisruption, previousGeneration: number): void {
  if (record.generation <= previousGeneration) {
    throw new Error('viewport resize handler ran but did not advance the disruption generation');
  }
  if (record.stableFrames !== 0) {
    throw new Error(`viewport resize handler ran but did not reset stableFrames to 0 (got ${record.stableFrames})`);
  }
}

/** Samples must be sliced at release, so an earlier handshake cannot satisfy the fresh-frame check. */
export function assertFreshStableFrames(samples: readonly TransitionStableFrame[], resetGeneration: number): void {
  const first = samples.at(-2);
  const second = samples.at(-1);
  if (
    first === undefined || second === undefined ||
    first.generation < resetGeneration || second.generation !== first.generation ||
    first.stableFrames !== 1 || second.stableFrames !== 2
  ) {
    throw new Error('reveal did not complete two fresh stable frames in the same post-disruption generation');
  }
}
