import { describe, expect, it } from 'vitest';
import { overlayWanted } from '../../src/proof/overlay';

describe('overlayWanted', () => {
  it('is true for ?proof=1, false without it, and true in dev regardless', () => {
    expect(overlayWanted('?proof=1', false)).toBe(true);
    expect(overlayWanted('', false)).toBe(false);
    expect(overlayWanted('', true)).toBe(true);
    expect(overlayWanted('?proof=0', false)).toBe(false);
    expect(overlayWanted('?proof=0', true)).toBe(true);
  });
});
