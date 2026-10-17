// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import type { CatalogLook } from '../../src/catalog/catalog';
import { mountProductCard, variantDisplayName } from '../../src/ui/product-card';
import { LOOK, OTHER, actions, button, makeLook, mount, root, swatch, swatchNames } from '../support/chrome-card';

// What a mounted card renders: the thumbnail and its placeholder window, the Source link, the
// actions row, the region name, the DOM order a visitor observes, and the empty plinth and
// variant names outside the catalogue's vocabulary.

describe('mountProductCard', () => {
  it('shows the empty thumbnail on image failure and restores an image for a later look', () => {
    const handle = mount();
    const empty = root.querySelector<HTMLElement>('.product-card__thumb-empty');
    for (const look of [LOOK, OTHER]) {
      handle.setLook(look, 'base');
      const image = root.querySelector<HTMLImageElement>('.product-card__thumb');
      expect(image?.hidden).toBe(false);
      expect(image?.getAttribute('src')).toBe(`/content/${look.thumbnail}`);
      expect(empty?.hidden).toBe(true);
      image?.dispatchEvent(new Event('error'));
      expect(image?.hidden).toBe(true);
      expect(empty?.hidden).toBe(false);
      expect(empty?.getAttribute('aria-hidden')).toBe('true');
      expect(empty?.textContent).toBe('');
      expect(root.querySelector('.product-card__name')?.textContent).toBe(look.name);
    }
    handle.setLook(LOOK, 'base');
    expect(root.querySelector<HTMLImageElement>('.product-card__thumb')?.hidden).toBe(false);
    expect(empty?.hidden).toBe(true);
  });

  it.each(['replacement', 'no-look', 'disposal'] as const)(
    'retires failed-thumbnail listeners after %s', (retirement) => {
      const handle = mount();
      const image = root.querySelector<HTMLImageElement>('.product-card__thumb');
      expect(image?.hidden).toBe(false);
      if (retirement === 'disposal') handle.dispose();
      else handle.setLook(retirement === 'no-look' ? null : OTHER, 'base');
      image?.dispatchEvent(new Event('error'));
      expect(image?.hidden).toBe(false);
      if (retirement === 'replacement') {
        expect(root.querySelector<HTMLImageElement>('.product-card__thumb')?.hidden).toBe(false);
        expect(root.querySelector<HTMLElement>('.product-card__thumb-empty')?.hidden).toBe(true);
      }
    },
  );

  it('renders a native, focusable Source link under the description with safe new-tab attributes', () => {
    const sourceUrl = 'https://example.com/source?id=42';
    mount({ look: { ...LOOK, sourceUrl } });
    const source = root.querySelector<HTMLAnchorElement>('.product-card__source');
    expect(source).toBeInstanceOf(HTMLAnchorElement);
    expect(source?.hidden).toBe(false);
    expect(source?.getAttribute('href')).toBe(sourceUrl);
    expect(source?.textContent).toBe('Source');
    expect(source?.getAttribute('aria-label')).toBe('Source (opens in a new tab)');
    expect(source?.target).toBe('_blank');
    expect(source?.rel).toBe('noopener noreferrer');
    expect(source?.previousElementSibling?.className).toBe('product-card__description');
    expect(source?.tabIndex).toBe(0);
    source?.focus();
    expect(document.activeElement).toBe(source);
  });

  it('updates the Source URL on replacement and hides and clears it without a source or look', () => {
    const handle = mount();
    const source = root.querySelector<HTMLAnchorElement>('.product-card__source');
    expect(source?.hidden).toBe(true);
    expect(source?.hasAttribute('href')).toBe(false);
    for (const look of [LOOK, OTHER]) {
      const sourceUrl = `https://example.com/${look.id}`;
      handle.setLook({ ...look, sourceUrl }, 'base');
      expect(source?.hidden).toBe(false);
      expect(source?.getAttribute('href')).toBe(sourceUrl);
    }
    for (const look of [LOOK, null]) {
      handle.setLook(look, null);
      expect(source?.hidden).toBe(true);
      expect(source?.hasAttribute('href')).toBe(false);
    }
  });

  it('renders the name, the description and the thumbnail', () => {
    mount();
    const heading = root.querySelector('.product-card h2');
    expect(heading?.textContent).toBe('Wallis Dress');
    const text = root.querySelector('.product-card p');
    expect(text?.textContent).toBe('Wallis Dress description');
    const image = root.querySelector<HTMLImageElement>('.product-card__thumb');
    expect(image?.getAttribute('src')).toBe('/content/thumbs/wallis-dress.jpg');
    expect(image?.alt).toBe('Wallis Dress');
  });

  it('prepends the card, so it lands above what the panel already held', () => {
    const existing = document.createElement('div');
    root.appendChild(existing);
    mount();
    expect(root.firstElementChild?.classList.contains('product-card')).toBe(true);
    expect(root.lastElementChild).toBe(existing);
  });

  it('renders the three actions as buttons in one row', () => {
    mount();
    const row = root.querySelector('.product-card__actions');
    expect(row?.getAttribute('role')).toBe('group');
    const labels = [...(row?.querySelectorAll('button') ?? [])].map(
      (element) => element.textContent,
    );
    expect(labels).toEqual(['Rotate', 'Reset', 'Material']);
  });

  it('renders one radio per variant, in the look order, the given one checked', () => {
    mount({ variant: 'light' });
    const group = root.querySelector('.product-card__swatches');
    expect(group?.getAttribute('role')).toBe('radiogroup');
    expect(group?.getAttribute('aria-label')).toBe('Mannequin material');
    expect(swatchNames()).toEqual(['Default', 'Light', 'Dark charcoal']);
    expect(swatch('light').getAttribute('aria-checked')).toBe('true');
    expect(swatch('base').getAttribute('aria-checked')).toBe('false');
    expect(swatch('light').className).toContain('product-card__swatch--light');
    // Roving tabindex: one tab stop on the checked radio
    expect(swatch('light').tabIndex).toBe(0);
    expect(swatch('base').tabIndex).toBe(-1);
    expect(swatch('dark').tabIndex).toBe(-1);
  });

  it('sets data-tooltip on actions and swatches, omitting title on swatches', () => {
    mount();
    expect(button('Rotate').dataset.tooltip).toBe('Rotate the look');
    expect(button('Reset').dataset.tooltip).toBe('Reset camera and mannequin');
    expect(button('Material').dataset.tooltip).toBe('Show mannequin swatches');

    expect(swatch('base').dataset.tooltip).toBe('Mannequin in default tone');
    expect(swatch('light').dataset.tooltip).toBe('Mannequin in light tone');
    expect(swatch('dark').dataset.tooltip).toBe('Mannequin in dark charcoal tone');
    expect(swatch('base').hasAttribute('title')).toBe(false);
  });

  it('leaves an honest empty card for a null look', () => {
    mount({ look: null, variant: null });
    expect(root.querySelector('.product-card h2')?.textContent).toBe('');
    expect(root.querySelector('.product-card p')?.textContent).toBe(
      'No look on the plinth yet.',
    );
    expect(root.querySelectorAll('.product-card__swatch')).toHaveLength(0);
  });

  it('starts with the swatch row open and the Material button expanded', () => {
    mount();
    const row = root.querySelector<HTMLElement>('.product-card__swatches');
    expect(row?.hidden).toBe(false);
    expect(button('Material').getAttribute('aria-expanded')).toBe('true');
    expect(button('Material').getAttribute('aria-controls')).toBe(
      root.querySelector('.product-card__swatches')?.id,
    );
  });
});

describe('the card region name', () => {
  it('names the region from its own heading instead of a static label', () => {
    mount();
    const card = root.querySelector<HTMLElement>('.product-card')!;
    expect(card.getAttribute('aria-label')).toBeNull();
    const labelledBy = card.getAttribute('aria-labelledby');
    expect(labelledBy).not.toBeNull();
    const heading = root.querySelector<HTMLElement>('.product-card__name')!;
    expect(heading.tagName).toBe('H2');
    // The reference must resolve, inside this card, to the heading that shows the look name.
    expect(labelledBy).toBe(heading.id);
    expect(document.getElementById(labelledBy!)).toBe(heading);
    expect(heading.textContent).toBe('Wallis Dress');
  });

  it('follows look switches on the same heading element', () => {
    const handle = mount();
    const card = root.querySelector<HTMLElement>('.product-card')!;
    const heading = root.querySelector<HTMLElement>('.product-card__name')!;
    handle.setLook(OTHER, 'base');
    // The heading node survives the switch, so the id stays valid and the region reads the new
    // look's name without any per-switch update.
    expect(root.querySelector('.product-card__name')).toBe(heading);
    expect(card.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(heading.textContent).toBe('Zoot Suit');
    expect(document.getElementById(heading.id)?.textContent).toBe('Zoot Suit');
  });

  it('gives each mounted card a heading id of its own', () => {
    mount();
    const secondRoot = document.createElement('aside');
    document.body.appendChild(secondRoot);
    try {
      const second = mountProductCard(secondRoot, {
        look: OTHER,
        variant: 'base',
        thumbnailUrl: (look: CatalogLook): string => `/content/${look.thumbnail ?? ''}`,
        actions: actions(),
      });
      const first = root.querySelector<HTMLElement>('.product-card')!;
      const secondCard = secondRoot.querySelector<HTMLElement>('.product-card')!;
      const firstId = first.getAttribute('aria-labelledby');
      const secondId = secondCard.getAttribute('aria-labelledby');
      expect(firstId).not.toBe(secondId);
      expect(first.contains(document.getElementById(firstId!))).toBe(true);
      expect(secondCard.contains(document.getElementById(secondId!))).toBe(true);
      expect(document.getElementById(firstId!)?.textContent).toBe('Wallis Dress');
      expect(document.getElementById(secondId!)?.textContent).toBe('Zoot Suit');
      second.dispose();
    } finally {
      secondRoot.remove();
    }
  });
});

describe('the card structure a visitor observes', () => {
  it('stacks the head thumbnail-first and heading below it, name above description', () => {
    mount();
    const head = root.querySelector('.product-card__head');
    // The stylesheet lays these out as a column with no order overrides, so DOM order is
    // visual order: the image block leads, then the text block.
    expect([...(head?.children ?? [])].map((element) => element.className)).toEqual([
      'product-card__thumb',
      'product-card__thumb-empty',
      'product-card__heading',
    ]);
    const heading = root.querySelector('.product-card__heading');
    expect([...(heading?.children ?? [])].map((element) => element.className)).toEqual([
      'product-card__name',
      'product-card__description',
      'product-card__source',
    ]);
  });

  it('names the actions group and keeps every action a plain button', () => {
    mount();
    const row = root.querySelector('.product-card__actions');
    expect(row?.getAttribute('aria-label')).toBe('Look actions');
    for (const element of row?.querySelectorAll('button') ?? []) {
      expect(element.type).toBe('button');
    }
  });

  it('keys each action by its own data-action, the selector keyboard support finds it by', () => {
    mount();
    expect(button('Rotate').dataset.action).toBe('rotate');
    expect(button('Reset').dataset.action).toBe('reset');
    expect(button('Material').dataset.action).toBe('material');
  });

  it('announces every swatch as a radio inside the radiogroup', () => {
    mount();
    const swatches = root.querySelectorAll('.product-card__swatch');
    expect(swatches.length).toBeGreaterThan(0);
    for (const element of swatches) {
      expect(element.getAttribute('role')).toBe('radio');
    }
  });

  it('starts Rotate unpressed', () => {
    mount();
    expect(button('Rotate').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('variant names the catalogue does not know', () => {
  it('keeps the variant id as the swatch name and phrases its tooltip from the same id', () => {
    mount({ look: makeLook('ivory-look', 'Ivory Look', ['base', 'ivory']), variant: 'base' });
    expect(variantDisplayName('ivory')).toBe('ivory');
    expect(swatchNames()).toEqual(['Default', 'ivory']);
    expect(swatch('ivory').dataset.tooltip).toBe('Mannequin in ivory tone');
  });
});

describe('the empty plinth', () => {
  it('hides the thumbnail box and shows the placeholder for a null look', () => {
    mount({ look: null, variant: null });
    expect(root.querySelector<HTMLElement>('.product-card__thumb')?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('.product-card__thumb-empty')?.hidden).toBe(false);
  });
});

describe('the thumbnail placeholder window', () => {
  it('holds the placeholder until the scene mark, then shows the image', async () => {
    // The first-frame mark is module state already consumed by the tests above, so this case
    // loads a fresh module pair and clears the performance timeline to observe the window.
    vi.resetModules();
    performance.clearMarks();
    const localRoot = document.createElement('aside');
    document.body.appendChild(localRoot);
    try {
      const { mountProductCard: mountFresh } = await import('../../src/ui/product-card');
      const { markFirstFrame: markFresh } = await import('../../src/proof/marks');
      const handle = mountFresh(localRoot, {
        look: LOOK,
        variant: 'base',
        thumbnailUrl: (look: CatalogLook): string => `/content/${look.thumbnail ?? ''}`,
        actions: actions(),
      });
      const thumb = localRoot.querySelector<HTMLImageElement>('.product-card__thumb');
      const empty = localRoot.querySelector<HTMLElement>('.product-card__thumb-empty');
      expect(thumb?.hidden).toBe(true);
      expect(empty?.hidden).toBe(false);
      expect(thumb?.hasAttribute('src')).toBe(false);
      markFresh();
      expect(thumb?.hidden).toBe(false);
      expect(empty?.hidden).toBe(true);
      handle.dispose();
    } finally {
      performance.clearMarks();
      localRoot.remove();
    }
  });

  it('keeps the placeholder and assigns no source for a look without a thumbnail', () => {
    // The chrome resolves a missing thumbnail to an empty string, so the card owns the
    // decision that an empty URL means no image, not a broken one.
    mount({ thumbnailUrl: (): string => '' });
    const thumb = root.querySelector<HTMLImageElement>('.product-card__thumb');
    const empty = root.querySelector<HTMLElement>('.product-card__thumb-empty');
    expect(thumb?.hasAttribute('src')).toBe(false);
    expect(thumb?.hidden).toBe(true);
    expect(empty?.hidden).toBe(false);
    expect(thumb?.alt).toBe('');
  });
});
