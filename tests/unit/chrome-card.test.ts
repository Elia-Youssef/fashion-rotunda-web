// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { markFirstFrame } from '../../src/proof/marks';
import type { CatalogLook } from '../../src/catalog/catalog';
import { mountProductCard } from '../../src/ui/product-card';
import type { ProductCardActions, ProductCardHandle } from '../../src/ui/product-card';

function makeLook(id: string, name: string, variants: string[]): CatalogLook {
  return {
    id,
    name,
    description: `${name} description`,
    thumbnail: `thumbs/${id}.jpg`,
    file: `looks/${id}.glb`,
    variants,
    defaultVariant: variants[0],
    mannequinNode: 'mannequin',
  };
}

const LOOK = makeLook('wallis-dress', 'Wallis Dress', ['base', 'light', 'dark']);
const OTHER = makeLook('zoot-suit', 'Zoot Suit', ['base', 'light', 'dark']);

let root: HTMLElement;
let card: ProductCardHandle | null = null;

beforeEach(() => {
  markFirstFrame();
  root = document.createElement('aside');
  document.body.appendChild(root);
});

afterEach(() => {
  card?.dispose();
  card = null;
  root.remove();
});

function actions(): ProductCardActions {
  return {
    rotate: vi.fn(),
    reset: vi.fn(),
    material: vi.fn(),
  };
}

interface MountOverrides {
  look?: CatalogLook | null;
  variant?: string | null;
  handlers?: ProductCardActions;
}

function mount(overrides: MountOverrides = {}): ProductCardHandle {
  card = mountProductCard(root, {
    look: 'look' in overrides ? overrides.look : LOOK,
    variant: overrides.variant ?? 'base',
    thumbnailUrl: (look: CatalogLook): string => `/content/${look.thumbnail ?? ''}`,
    actions: overrides.handlers ?? actions(),
  });
  return card;
}

function button(label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('.product-card__action')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

function swatch(variant: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(
    `.product-card__swatch[aria-label="${variant}"]`,
  );
  if (!found) throw new Error(`no swatch for ${variant}`);
  return found;
}

function swatchNames(): string[] {
  return [...root.querySelectorAll('.product-card__swatch')].map(
    (element) => element.getAttribute('aria-label') ?? '',
  );
}

describe('mountProductCard', () => {
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
    expect(swatchNames()).toEqual(['base', 'light', 'dark']);
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
    expect(button('Rotate').dataset.tooltip).toBe('Turn the look');
    expect(button('Reset').dataset.tooltip).toBe('Reset camera and mannequin');
    expect(button('Material').dataset.tooltip).toBe('Show mannequin swatches');

    expect(swatch('base').dataset.tooltip).toBe('Mannequin in default tone');
    expect(swatch('light').dataset.tooltip).toBe('Copy of the mannequin in a lighter tone');
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
    card = null;
    expect(root.childElementCount).toBe(0);
    dark.click();
    rotate.click();
    expect(handlers.material).not.toHaveBeenCalled();
    expect(handlers.rotate).not.toHaveBeenCalled();
  });
});

describe('swatch accessibility contract', () => {
  it.each([
    ['same variants', ['base', 'light', 'dark'], 'dark', 'light'],
    ['reordered variants', ['dark', 'base', 'light'], 'dark', 'light'],
    ['removed variant with checked fallback', ['base', 'dark'], 'dark', 'dark'],
    ['removed variant with first fallback', ['dark', 'base'], null, 'dark'],
    ['removed variant with unknown selection', ['dark', 'base'], 'missing', 'dark'],
  ] as const)('preserves focus for %s and keeps arrow navigation working', (_, variants, selected, expected) => {
    const handlers = actions();
    const handle = mount({ handlers });
    swatch('light').focus();
    handle.setLook(makeLook('replacement', 'Replacement', [...variants]), selected);
    expect(document.activeElement).toBe(swatch(expected));
    const order: readonly string[] = variants;
    const next = order[(order.indexOf(expected) + 1) % order.length];
    swatch(expected).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(swatch(next));
    expect(handlers.material).toHaveBeenCalledExactlyOnceWith(next);
    expect(swatch(next).getAttribute('aria-checked')).toBe('true');
  });

  it.each(['no look', 'empty variants'] as const)('keeps a keyboard destination for %s', (empty) => {
    const handle = mount();
    swatch('light').focus();
    handle.setLook(empty === 'no look' ? null : makeLook('empty', 'Empty', []), null);
    expect(root.querySelectorAll('[role="radio"]')).toHaveLength(0);
    expect(document.activeElement).toBe(button('Material'));
  });

  it.each(['outside card', 'card action'] as const)('leaves focus on %s during replacement and clearing', (where) => {
    const handle = mount();
    const outside = document.createElement('button');
    root.appendChild(outside);
    const focused = where === 'outside card' ? outside : button('Reset');
    focused.focus();
    handle.setLook(OTHER, 'dark');
    expect(document.activeElement).toBe(focused);
    handle.setLook(null, null);
    expect(document.activeElement).toBe(focused);
  });
});
