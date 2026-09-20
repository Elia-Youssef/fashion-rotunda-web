import { describe, expect, it } from 'vitest';

import { transcoderPath } from '../../src/scene/loaders';

describe('transcoderPath', () => {
  it.each([
    ['/content', '/content/basis/'],
    ['/content/', '/content/basis/'],
    ['/content/half', '/content/basis/'],
    ['/content/half/', '/content/basis/'],
  ])('uses the shared transcoder for %s', (contentBase, expected) => {
    expect(transcoderPath(contentBase)).toBe(expected);
  });
});
