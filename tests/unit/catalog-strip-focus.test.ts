// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { focusedThumbnailScrollLeft, mountCatalogStrip } from '../../src/ui/catalog-strip';
import type { CatalogStripHandle } from '../../src/ui/catalog-strip';
import type { CatalogLook } from '../../src/catalog/catalog';

describe('focusedThumbnailScrollLeft', () => {
  it.each([
    ['already visible', 130, 178, 5, 5, 40],
    ['exactly visible with margins', 105, 195, 5, 5, 40],
    ['cut at the end', 171, 219, 0, 0, 59],
    ['cut at the start', 81, 129, 0, 0, 21],
    ['end margin clipped', 152, 200, 3, 7, 47],
    ['start margin clipped', 100, 148, 7, 3, 33],
    ['oversized spanning both edges', 90, 210, 5, 5, 40],
    ['oversized beyond the end', 120, 240, 5, 5, 55],
    ['oversized beyond the start', 60, 180, 5, 5, 25],
    ['fractional coordinates and margins', 150.5, 198.5, 2.25, 4.25, 42.75],
  ] as const)('%s', (_name, left, right, marginLeft, marginRight, target) => {
    expect(
      focusedThumbnailScrollLeft(
        { left: 100, right: 200 },
        { left, right },
        { left: marginLeft, right: marginRight },
        40,
      ),
    ).toBe(target);
  });
});

const looks: CatalogLook[] = ['first', 'middle', 'last'].map((id) => ({
  id,
  name: id,
  description: '',
  thumbnail: null,
  file: `looks/${id}.glb`,
  variants: ['base'],
  defaultVariant: 'base',
  mannequinNode: 'mannequin',
}));

let strip: CatalogStripHandle | undefined;

afterEach(() => {
  strip?.dispose();
  strip = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(width = 390) {
  const matchMedia = vi.fn((query: string) => ({
    matches: query === '(min-width: 1200px)' ? width >= 1200 : true,
  }));
  vi.stubGlobal('matchMedia', matchMedia);
  const ancestor = document.createElement('section');
  const root = document.createElement('nav');
  ancestor.appendChild(root);
  document.body.appendChild(ancestor);
  const scroll = vi.fn();
  const ancestorScroll = vi.fn();
  Object.defineProperty(root, 'scrollTo', { value: scroll });
  Object.defineProperty(ancestor, 'scrollTo', { value: ancestorScroll });
  const documentScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  Object.defineProperties(root, {
    clientLeft: { value: 2 },
    clientWidth: { value: 100 },
  });
  root.scrollLeft = 40;
  root.scrollTop = 17;
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(98, 30, 104, 60));
  strip = mountCatalogStrip(root, {
    looks,
    thumbnailUrl: () => '',
    current: null,
    onSelect: vi.fn(),
  });
  const buttons = [...root.querySelectorAll('button')];
  for (const button of buttons) {
    button.style.scrollMarginLeft = '3px';
    button.style.scrollMarginRight = '7px';
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(171, 40, 48, 48));
  }
  return { root, buttons, scroll, ancestorScroll, documentScroll, matchMedia };
}

describe('horizontal thumbnail focus', () => {
  it.each([390, 820, 1199.5])('scrolls only the strip instantly at width %s', (width) => {
    const { root, buttons, scroll, ancestorScroll, documentScroll } = fixture(width);
    for (const button of buttons) {
      button.focus();
      expect(scroll).toHaveBeenLastCalledWith({ left: 66, behavior: 'instant' });
    }
    expect(scroll).toHaveBeenCalledTimes(buttons.length);
    expect(root.scrollTop).toBe(17);
    expect(ancestorScroll).not.toHaveBeenCalled();
    expect(documentScroll).not.toHaveBeenCalled();
  });

  it('reveals the start margin in the strip client area', () => {
    const { buttons, scroll } = fixture();
    vi.mocked(buttons[0].getBoundingClientRect).mockReturnValue(new DOMRect(81, 40, 48, 48));
    buttons[0].focus();
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ left: 18, behavior: 'instant' });
  });

  it('does not scroll an already visible thumbnail', () => {
    const { buttons, scroll } = fixture();
    vi.mocked(buttons[0].getBoundingClientRect).mockReturnValue(new DOMRect(130, 40, 48, 48));
    buttons[0].focus();
    expect(scroll).not.toHaveBeenCalled();
  });

  it.each([1200, 1440])('leaves the desktop rail alone at width %s', (width) => {
    const { buttons, scroll, matchMedia } = fixture(width);
    buttons[0].focus();
    expect(matchMedia).toHaveBeenCalledWith('(min-width: 1200px)');
    expect(scroll).not.toHaveBeenCalled();
    expect(buttons[0].getBoundingClientRect).not.toHaveBeenCalled();
  });

  it('removes the focus listener on disposal', () => {
    const { root, buttons, scroll } = fixture();
    strip?.dispose();
    root.appendChild(buttons[0]);
    buttons[0].focus();
    expect(scroll).not.toHaveBeenCalled();
  });
});
