import { describe, expect, it } from 'vitest';

import { loopPosition } from '../../src/audio/loop-math';

const DURATION = 105.65;

describe('loopPosition', () => {
  it('counts elapsed time from the start', () => {
    expect(loopPosition(10, 0, 10, DURATION)).toBe(0);
    expect(loopPosition(10, 0, 13.5, DURATION)).toBeCloseTo(3.5, 9);
  });

  it('carries a non-zero start offset', () => {
    expect(loopPosition(10, 2, 13, DURATION)).toBeCloseTo(5, 9);
    expect(loopPosition(10, 40, 10, DURATION)).toBeCloseTo(40, 9);
  });

  it('wraps at the duration', () => {
    // Offset 40 plus 105.35 s elapsed is 145.35 s: one boundary crossed, 39.7 s into the next turn.
    expect(loopPosition(0, 40, 105.35, DURATION)).toBeCloseTo(39.7, 9);
  });

  it('wraps several times over a long wait', () => {
    // 3 full turns plus 7 s, from offset 2.
    const now = DURATION * 3 + 7;
    expect(loopPosition(0, 2, now, DURATION)).toBeCloseTo(9, 9);
  });

  it('lands exactly on the boundary as zero, not as the duration', () => {
    expect(loopPosition(0, 95, 10.65, DURATION)).toBeCloseTo(0, 9);
  });

  it('reads the start offset before the start time', () => {
    expect(loopPosition(10, 3, 4, DURATION)).toBeCloseTo(3, 9);
    expect(loopPosition(10, 3, 10, DURATION)).toBeCloseTo(3, 9);
  });

  it('normalizes a negative input onto the loop', () => {
    expect(loopPosition(0, -2.5, 0, DURATION)).toBeCloseTo(DURATION - 2.5, 9);
  });
});
