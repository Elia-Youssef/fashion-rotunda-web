// Where a loop stands right now. The player keeps no per-frame clock of its own (the page renders
// on demand and may not draw for minutes); the context's currentTime is the one clock that moves
// while the audio plays, and this turns it into a position inside the loop.

/**
 * Where a loop stands at `now`: it started at `startedAt` from `startOffset`, and wraps at
 * `duration`. A `now` before `startedAt` reads as the offset it will start from.
 */
export function loopPosition(startedAt: number, startOffset: number, now: number, duration: number): number {
  const elapsed = Math.max(0, now - startedAt);
  const raw = startOffset + elapsed;
  const wrapped = raw % duration;
  // The remainder keeps the sign of the dividend; only a negative input reaches the correction.
  return wrapped < 0 ? wrapped + duration : wrapped;
}
