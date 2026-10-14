import { describe, expect, it } from 'vitest';

import { readStylesheet } from '../support/stylesheet';

// The proof panel's border and text colours come from the page tokens. These checks pin the
// swap: the panel must reference the tokens, and each token must resolve to the exact value the
// panel painted while it carried the literal itself, so the replacement moves no pixel.

const { declaration, color } = readStylesheet('src/proof/panel.css', 'src/styles.css');

describe('the proof panel paints its former literal values through the page tokens', () => {
  it('draws the panel border and text from the border and text tokens', () => {
    expect(declaration('.proof-panel', 'border')).toBe('1px solid var(--border)');
    expect(declaration('.proof-panel', 'color')).toBe('var(--text-muted)');
    expect(declaration('.proof-panel__measure', 'color')).toBe('var(--text)');
  });

  it('resolves each of the three tokens to the literal it replaced', () => {
    expect(color('var(--border)')).toEqual(color('#3a4048'));
    expect(color('var(--text-muted)')).toEqual(color('#9aa2ab'));
    expect(color('var(--text)')).toEqual(color('#e6e8ea'));
  });
});
