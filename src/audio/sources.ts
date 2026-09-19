// Choosing which encoded file to fetch. The manifest lists one Opus and one AAC source and the
// browser answers for each type through canPlayType, whose whole vocabulary is 'probably', 'maybe'
// and '' (no). A 'probably' is a firm yes, a 'maybe' is a fallback, and the first firm yes wins
// even when a 'maybe' was seen earlier in the list.

import type { TrackSource } from './music';

/** The first source whose type gets 'probably', else the first that gets 'maybe', else null. */
export function pickSource(
  sources: TrackSource[],
  canPlayType: (type: string) => string,
): TrackSource | null {
  let maybe: TrackSource | null = null;
  for (const source of sources) {
    const answer = canPlayType(source.type);
    if (answer === 'probably') {
      return source;
    }
    if (maybe === null && answer === 'maybe') {
      maybe = source;
    }
  }
  return maybe;
}
