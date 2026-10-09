import { describe, expect, it } from 'vitest';
import { correctDescription } from '../../pipeline/gltf/lib/catalog-corrections.mjs';

const SOURCE_DESCRIPTION =
  'Blue silk lace insets and handkerchief skirt panels over a crepe de chine lining. ' +
  'It was owned by Carrie Lane Chatman Catt born in 1859. A skilled political strategist, ' +
  'Carrie Clinton Lane Chapman Catt was a suffragist and peace activist who helped secure ' +
  'for American women the right to vote.';

const CORRECTED_DESCRIPTION =
  'Blue silk lace insets and handkerchief skirt panels over a crepe de chine lining. ' +
  'It was owned by Carrie Lane Chapman Catt born in 1859. A skilled political strategist, ' +
  'Carrie Clinton Lane Chapman Catt was a suffragist and peace activist who helped secure ' +
  'for American women the right to vote.';

describe('catalogue description corrections', () => {
  it('corrects the matching look while preserving the rest of its description', () => {
    expect(correctDescription('blue-silk-dress', SOURCE_DESCRIPTION)).toBe(CORRECTED_DESCRIPTION);
  });

  it('leaves other looks untouched even when they contain the same source text', () => {
    for (const description of [SOURCE_DESCRIPTION, 'A different description.', '']) {
      expect(correctDescription('another-look', description)).toBe(description);
    }
  });

  it('rejects missing, changed or already corrected text with the look and expected source text', () => {
    for (const description of ['', 'Carrie Lane CHATMAN Catt', CORRECTED_DESCRIPTION]) {
      expect(() => correctDescription('blue-silk-dress', description)).toThrow(
        'Description correction for look "blue-silk-dress" expected text: "Carrie Lane Chatman Catt"',
      );
    }
  });
});
