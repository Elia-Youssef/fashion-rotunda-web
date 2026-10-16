// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { markFirstFrame } from '../../src/proof/marks';
import type { CatalogLook } from '../../src/catalog/catalog';
import { mountCatalogStrip } from '../../src/ui/catalog-strip';
import type { CatalogStripHandle, CatalogStripOptions } from '../../src/ui/catalog-strip';

/** Seven ids, the count the shipped catalogue carries, so the strip is exercised at its real size. */
const IDS = [
  'wallis-dress',
  'zoot-suit',
  'new-look-dress',
  'mondrian-dress',
  'jumpsuit-dress',
  'blue-silk-dress',
  'geoffrey-beene',
];

function makeLook(id: string, thumbnail: string | null): CatalogLook {
  const name = `${id} name`;
  return {
    id,
    name,
    description: `${name} description`,
    thumbnail,
    file: `looks/${id}.glb`,
    variants: ['base', 'light', 'dark'],
    defaultVariant: 'base',
    mannequinNode: 'mannequin',
  };
}

const LOOKS: CatalogLook[] = IDS.map((id) => makeLook(id, `thumbs/${id}.jpg`));

let root: HTMLElement;
let strip: CatalogStripHandle | null = null;

beforeEach(() => {
  markFirstFrame();
  root = document.createElement('nav');
  document.body.appendChild(root);
});

afterEach(() => {
  strip?.dispose();
  strip = null;
  root.remove();
});

interface MountOverrides {
  looks?: CatalogLook[];
  thumbnailUrl?: (look: CatalogLook) => string;
  current?: string | null;
  onSelect?: (id: string) => void;
}

function mount(overrides: MountOverrides = {}): CatalogStripHandle {
  const options: CatalogStripOptions = {
    looks: overrides.looks ?? LOOKS,
    thumbnailUrl:
      overrides.thumbnailUrl ??
      ((look: CatalogLook): string => (look.thumbnail === null ? '' : `/content/${look.thumbnail}`)),
    current: overrides.current ?? null,
    onSelect: overrides.onSelect ?? vi.fn(),
  };
  strip = mountCatalogStrip(root, options);
  return strip;
}

function buttons(): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('button')];
}

function buttonFor(id: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(`button[data-look="${id}"]`);
  if (!found) throw new Error(`no button for ${id}`);
  return found;
}

describe('mountCatalogStrip', () => {
  it('replaces failed thumbnails with the existing empty box and preserves every button name and action', () => {
    const onSelect = vi.fn();
    mount({ onSelect, current: LOOKS[0].id });
    for (const look of LOOKS) {
      const button = buttonFor(look.id);
      const image = button.querySelector('img');
      expect(image).not.toBeNull();
      image?.dispatchEvent(new Event('error'));
      expect(button.querySelector('img')).toBeNull();
      const empty = button.querySelector('.catalog-strip__empty');
      expect(empty?.getAttribute('aria-hidden')).toBe('true');
      expect(empty?.textContent).toBe('');
      expect(button.querySelector('.catalog-strip__label')?.textContent).toBe(look.name);
      button.click();
      expect(onSelect).toHaveBeenLastCalledWith(look.id);
    }
    expect(buttonFor(LOOKS[0].id).getAttribute('aria-current')).toBe('true');
  });

  it('retires the thumbnail error handler on disposal', () => {
    const handle = mount();
    const button = buttonFor(LOOKS[0].id);
    const image = button.querySelector('img');
    handle.dispose();
    image?.dispatchEvent(new Event('error'));
    expect(button.querySelector('img')).toBe(image);
    expect(button.querySelector('.catalog-strip__empty')).toBeNull();
  });

  it('renders one native button per look, in catalogue order', () => {
    mount();
    const rendered = buttons();
    expect(rendered).toHaveLength(7);
    expect(rendered.map((button) => button.dataset.look)).toEqual(IDS);
    for (const button of rendered) {
      // Native buttons only: keyboard reach, Enter and Space come from the element itself.
      expect(button.tagName).toBe('BUTTON');
      expect(button.tabIndex).toBe(0);
      expect(button.disabled).toBe(false);
    }
  });

  it('labels the nav and gives each button the thumbnail and the look name', () => {
    mount();
    expect(root.getAttribute('aria-label')).toBe('Looks');
    for (const look of LOOKS) {
      const image = buttonFor(look.id).querySelector('img');
      expect(image?.getAttribute('src')).toBe(`/content/${look.thumbnail}`);
      // The hidden label is the name; an empty alt keeps the thumbnail decorative so a screen
      // reader does not read the look name twice.
      expect(image?.alt).toBe('');
      const label = buttonFor(look.id).querySelector('.catalog-strip__label');
      expect(label?.textContent).toBe(look.name);
    }
  });

  it('gives a look without a thumbnail an empty box, not an img', () => {
    mount({ looks: [makeLook('wallis-dress', null)] });
    const button = buttonFor('wallis-dress');
    expect(button.querySelector('img')).toBeNull();
    expect(button.querySelector('.catalog-strip__empty')).not.toBeNull();
  });

  it('marks the current look from the mount options', () => {
    mount({ current: 'zoot-suit' });
    expect(buttonFor('zoot-suit').getAttribute('aria-current')).toBe('true');
    expect(buttons().filter((button) => button.hasAttribute('aria-current'))).toHaveLength(1);
  });
});

describe('CatalogStripHandle.setCurrent', () => {
  it('moves aria-current and clears it with null', () => {
    const handle = mount({ current: 'wallis-dress' });
    handle.setCurrent('zoot-suit');
    expect(buttonFor('zoot-suit').getAttribute('aria-current')).toBe('true');
    expect(buttonFor('wallis-dress').hasAttribute('aria-current')).toBe(false);
    handle.setCurrent(null);
    expect(buttons().filter((button) => button.hasAttribute('aria-current'))).toHaveLength(0);
  });
});

describe('CatalogStripHandle.setBusy', () => {
  it('marks the look being fetched and clears it with null', () => {
    const handle = mount();
    handle.setBusy('mondrian-dress');
    expect(buttonFor('mondrian-dress').getAttribute('aria-busy')).toBe('true');
    expect(buttons().filter((button) => button.hasAttribute('aria-busy'))).toHaveLength(1);
    handle.setBusy(null);
    expect(buttons().filter((button) => button.hasAttribute('aria-busy'))).toHaveLength(0);
  });
});

describe('selecting a look', () => {
  it('reports the clicked look id through onSelect', () => {
    const onSelect = vi.fn();
    mount({ onSelect });
    buttonFor('new-look-dress').click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('new-look-dress');
  });
});

describe('CatalogStripHandle.dispose', () => {
  it('empties the root and stops the buttons from reporting', () => {
    const onSelect = vi.fn();
    const handle = mount({ onSelect });
    const button = buttonFor('wallis-dress');
    handle.dispose();
    strip = null;
    expect(root.childElementCount).toBe(0);
    button.click();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

// The desktop rail divides its height by --rail-look-count to size every thumbnail, so the token
// must match the looks the catalogue ships; a mismatch would make the rail scroll again.
describe('the desktop rail look count', () => {
  it('equals the number of looks in public/content/catalog.json', () => {
    const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
    const token = /--rail-look-count:\s*(\d+)\s*;/.exec(css);
    expect(token, '--rail-look-count is defined in styles.css').not.toBeNull();
    const catalog = JSON.parse(
      readFileSync(join(process.cwd(), 'public', 'content', 'catalog.json'), 'utf8'),
    ) as { looks: unknown[] };
    expect(Number(token?.[1])).toBe(catalog.looks.length);
  });
});
