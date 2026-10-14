import { describe, expect, it } from 'vitest';

import { readStylesheet } from '../support/stylesheet';

// The colour parser in tests/support/stylesheet.ts feeds every contrast contract, so its own
// contract pins the comma and slash colour syntaxes, with and without alpha.
const { color } = readStylesheet('src/styles.css');

describe('stylesheet colour parsing', () => {
  it('preserves alpha in comma and slash colour syntax', () => {
    expect(color('rgba(20, 40, 60, 0.5)')).toEqual([20, 40, 60, 0.5]);
    expect(color('rgb(20 40 60 / 0)')).toEqual([20, 40, 60, 0]);
    expect(color('rgb(20, 40, 60)')).toEqual([20, 40, 60, 1]);
  });
});
