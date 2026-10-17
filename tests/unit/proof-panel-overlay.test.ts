// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { overlayWanted } from '../../src/proof/overlay';

// The overlay switch: whether the proof panel exists at all, decided from dev mode and the
// ?proof=1 query before any panel behaviour applies.

describe('overlayWanted', () => {
  it('is true in dev or when ?proof=1 is in the search query', () => {
    expect(overlayWanted('?proof=1', false)).toBe(true);
    expect(overlayWanted('', false)).toBe(false);
    expect(overlayWanted('', true)).toBe(true);
    expect(overlayWanted('?proof=0', true)).toBe(true);
  });
});
