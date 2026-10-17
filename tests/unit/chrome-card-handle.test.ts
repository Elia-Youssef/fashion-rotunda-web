// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import type { CatalogLook } from '../../src/catalog/catalog';
import { OTHER, actions, button, mount, retireCard, root, swatch } from '../support/chrome-card';

// The imperative handle: setVariant, setRotating and setLook, the reporting behind the action
// buttons and swatch clicks, and disposal retiring the card's listeners and swatches.

describe('ProductCardHandle.setVariant', () => {
  it('moves the check and clears it with null', () => {
    const handle = mount();
    handle.setVariant('dark');
    expect(swatch('dark').getAttribute('aria-checked')).toBe('true');
    expect(swatch('base').getAttribute('aria-checked')).toBe('false');
    handle.setVariant(null);
    for (const name of ['base', 'light', 'dark']) {
      expect(swatch(name).getAttribute('aria-checked')).toBe('false');
    }
  });
});

describe('ProductCardHandle.setRotating', () => {
  it('drives aria-pressed on the Rotate button', () => {
    const handle = mount();
    handle.setRotating(true);
    expect(button('Rotate').getAttribute('aria-pressed')).toBe('true');
    handle.setRotating(false);
    expect(button('Rotate').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('ProductCardHandle.setLook', () => {
  it('re-renders the name, the text, the thumbnail and the swatches', () => {
    const handle = mount();
    handle.setLook(OTHER, 'dark');
    expect(root.querySelector('.product-card h2')?.textContent).toBe('Zoot Suit');
    expect(root.querySelector('.product-card p')?.textContent).toBe('Zoot Suit description');
    expect(root.querySelector<HTMLImageElement>('.product-card__thumb')?.getAttribute('src')).toBe(
      '/content/thumbs/zoot-suit.jpg',
    );
    expect(swatch('dark').getAttribute('aria-checked')).toBe('true');
  });

  it('resets the Material disclosure to open when look changes', () => {
    const handle = mount();
    const swatches = root.querySelector<HTMLElement>('.product-card__swatches');
    const material = button('Material');
    material.click();
    expect(swatches?.hidden).toBe(true);
    expect(material.getAttribute('aria-expanded')).toBe('false');

    handle.setLook(OTHER, 'base');
    expect(swatches?.hidden).toBe(false);
    expect(material.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('the card reporting actions', () => {
  it('reports Rotate and Reset through their own buttons', () => {
    const handlers = actions();
    mount({ handlers });
    button('Rotate').click();
    expect(handlers.rotate).toHaveBeenCalledTimes(1);
    button('Reset').click();
    expect(handlers.reset).toHaveBeenCalledTimes(1);
    expect(handlers.material).not.toHaveBeenCalled();
  });

  it('reports a swatch click with the variant name', () => {
    const handlers = actions();
    mount({ handlers });
    swatch('dark').click();
    expect(handlers.material).toHaveBeenCalledTimes(1);
    expect(handlers.material).toHaveBeenCalledWith('dark');
  });

  it('keeps the Material button to the card: it toggles the row, it reports nothing', () => {
    const handlers = actions();
    mount({ handlers });
    const swatches = root.querySelector<HTMLElement>('.product-card__swatches');
    const material = button('Material');
    expect(swatches?.hidden).toBe(false);
    expect(material.getAttribute('aria-expanded')).toBe('true');

    material.click();
    expect(handlers.rotate).not.toHaveBeenCalled();
    expect(handlers.reset).not.toHaveBeenCalled();
    expect(handlers.material).not.toHaveBeenCalled();
    expect(swatches?.hidden).toBe(true);
    expect(material.getAttribute('aria-expanded')).toBe('false');

    material.click();
    expect(swatches?.hidden).toBe(false);
    expect(material.getAttribute('aria-expanded')).toBe('true');
  });

  it('navigates swatches with arrow keys, Home and End in the radio group', () => {
    const handlers = actions();
    mount({ handlers, variant: 'base' });
    const swatchesContainer = root.querySelector('.product-card__swatches');
    expect(swatchesContainer).not.toBeNull();

    swatch('base').focus();
    expect(document.activeElement).toBe(swatch('base'));

    // ArrowRight moves to 'light'
    swatchesContainer?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    expect(handlers.material).toHaveBeenCalledWith('light');
    expect(swatch('light').getAttribute('aria-checked')).toBe('true');
    expect(swatch('light').tabIndex).toBe(0);
    expect(swatch('base').tabIndex).toBe(-1);

    // End moves to 'dark'
    swatchesContainer?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    );
    expect(handlers.material).toHaveBeenCalledWith('dark');
    expect(swatch('dark').getAttribute('aria-checked')).toBe('true');

    // Home moves to 'base'
    swatchesContainer?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    );
    expect(handlers.material).toHaveBeenCalledWith('base');
    expect(swatch('base').getAttribute('aria-checked')).toBe('true');
  });
});

describe('ProductCardHandle.dispose', () => {
  it.each(['replacement', 'no-look', 'disposal'] as const)(
    'retires retained swatches after %s',
    (retirement) => {
      const handlers = actions();
      const handle = mount({ handlers });
      const retained = ['base', 'light', 'dark'].map(swatch);
      if (retirement === 'disposal') {
        handle.dispose();
      } else {
        handle.setLook(retirement === 'no-look' ? null : OTHER, 'base');
      }
      for (const old of retained) {
        expect(old.isConnected).toBe(false);
        old.click();
      }
      expect(handlers.material).not.toHaveBeenCalled();
      if (retirement === 'replacement') {
        expect(swatch('base').getAttribute('aria-checked')).toBe('true');
        swatch('dark').click();
        expect(handlers.material).toHaveBeenCalledExactlyOnceWith('dark');
      }
    },
  );

  it('empties the root and stops the buttons from reporting', () => {
    const handlers = actions();
    const handle = mount({ handlers });
    const dark = swatch('dark');
    const rotate = button('Rotate');
    handle.dispose();
    retireCard();
    expect(root.childElementCount).toBe(0);
    dark.click();
    rotate.click();
    expect(handlers.material).not.toHaveBeenCalled();
    expect(handlers.rotate).not.toHaveBeenCalled();
  });
});

describe('ProductCardHandle after dispose', () => {
  it('renders nothing and asks for no thumbnail URL after dispose', () => {
    const thumbnailUrl = vi.fn((look: CatalogLook): string => `/content/${look.thumbnail ?? ''}`);
    const handle = mount({ thumbnailUrl });
    thumbnailUrl.mockClear();
    handle.dispose();
    retireCard();
    handle.setLook(OTHER, 'base');
    expect(thumbnailUrl).not.toHaveBeenCalled();
    expect(root.childElementCount).toBe(0);
    expect(root.querySelectorAll('.product-card__swatch')).toHaveLength(0);
  });
});
