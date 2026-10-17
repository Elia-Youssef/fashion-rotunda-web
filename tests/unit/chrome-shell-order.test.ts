// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogLook } from '../../src/catalog/catalog';
import { markFirstFrame } from '../../src/proof/marks';
import { mountProductCard } from '../../src/ui/product-card';
import type { ProductCardHandle } from '../../src/ui/product-card';
import { mountShare } from '../../src/ui/share';
import type { ShareHandle } from '../../src/ui/share';
import { mountShell } from '../../src/ui/shell';
import type { ShellHandle } from '../../src/ui/shell';
import { buildDocument, stubViewport } from '../support/chrome-shell';

const LOOK: CatalogLook = {
  id: 'wallis-dress',
  name: 'Wallis Dress',
  description: 'Dress description',
  sourceUrl: 'https://example.com/dress',
  thumbnail: null,
  file: 'looks/wallis-dress.glb',
  variants: ['base', 'light', 'dark'],
  defaultVariant: 'base',
  mannequinNode: 'mannequin',
};

let shell: ShellHandle | null = null;
let card: ProductCardHandle | null = null;
let share: ShareHandle | null = null;

/** jsdom has no Tab navigation or layout; filter DOM order by the controls' hidden contracts. */
function tabOrder(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button, [href], input, select, [tabindex]')]
    .filter((control) => control.tabIndex >= 0 && !control.matches(':disabled') &&
      control.closest('[hidden], [inert], .share__fallback--hidden') === null);
}

function labels(controls: HTMLElement[]): string[] {
  return controls.map((control) => control.getAttribute('aria-label') ?? control.textContent ?? '');
}

beforeEach(() => {
  buildDocument();
  markFirstFrame();
});

afterEach(() => {
  share?.dispose();
  card?.dispose();
  shell?.dispose();
  share = null;
  card = null;
  shell = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe.each([
  { width: 390, height: 844 },
  { width: 844, height: 390 },
])('sheet reading order at $width x $height', ({ width, height }) => {
  beforeEach(() => {
    stubViewport(width, height);
    shell = mountShell(document);
  });

  it('places chrome first and one content slot second in both sheets', () => {
    for (const id of ['shell-card', 'shell-light-row']) {
      const sheet = document.getElementById(id)!;
      expect([...sheet.children].map((child) => child.className)).toEqual([
        'shell-sheet__chrome', 'shell-sheet__content',
      ]);
      expect(sheet.firstElementChild?.querySelector('button')?.getAttribute('aria-label')).toBe('Close');
    }
  });

  it('orders Close, product controls and share controls inside the card sheet', () => {
    const root = shell!.roots.card;
    card = mountProductCard(root, {
      look: LOOK,
      variant: 'base',
      thumbnailUrl: () => '',
      actions: { rotate: vi.fn(), reset: vi.fn(), material: vi.fn() },
    });
    share = mountShare(root, {
      copyLink: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => undefined),
    });
    const content = root.querySelector('.shell-sheet__content')!;
    expect([...content.children].map((child) => child.className)).toEqual(['product-card', 'share']);
    shell!.setCardOpen(true);
    expect(document.activeElement).toBe(root.querySelector('.shell-sheet__close'));
    expect(labels(tabOrder(root))).toEqual([
      'Close', 'Source (opens in a new tab)', 'Rotate', 'Reset', 'Material', 'Default',
      'Copy link', 'Screenshot',
    ]);

    card.setVariant('dark');
    expect(labels(tabOrder(root))).toEqual([
      'Close', 'Source (opens in a new tab)', 'Rotate', 'Reset', 'Material', 'Dark charcoal',
      'Copy link', 'Screenshot',
    ]);
    const lookWithoutSource = { ...LOOK };
    delete lookWithoutSource.sourceUrl;
    card.setLook(lookWithoutSource, 'base');
    root.querySelector<HTMLButtonElement>('[data-action="material"]')!.click();
    const fallback = root.querySelector<HTMLInputElement>('.share__fallback')!;
    fallback.classList.remove('share__fallback--hidden');
    expect(labels(tabOrder(root))).toEqual([
      'Close', 'Rotate', 'Reset', 'Material', 'Copy link', 'Screenshot', 'Shareable link',
    ]);
  });

  it('keeps the card ahead of the share row when the share row mounts first', () => {
    const root = shell!.roots.card;
    share = mountShare(root, {
      copyLink: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => undefined),
    });
    card = mountProductCard(root, {
      look: LOOK,
      variant: 'base',
      thumbnailUrl: () => '',
      actions: { rotate: vi.fn(), reset: vi.fn(), material: vi.fn() },
    });
    const content = root.querySelector('.shell-sheet__content')!;
    expect([...content.children].map((child) => child.className)).toEqual(['product-card', 'share']);
  });

  it('orders Close before the light disclosure and panel controls', () => {
    const panel = shell!.roots.lightPanel;
    const on = document.createElement('input');
    on.type = 'checkbox';
    on.setAttribute('aria-label', 'Key on');
    const intensity = document.createElement('input');
    intensity.type = 'range';
    intensity.setAttribute('aria-label', 'Key intensity');
    panel.append(on, intensity);
    shell!.setLightPanelOpen(true);
    const row = document.getElementById('shell-light-row')!;
    expect(labels(tabOrder(row))).toEqual(['Close', 'Light Control', 'Key on', 'Key intensity']);
    expect(panel.parentElement).toBe(row.lastElementChild);
  });

  it('orders the closed bottom band from Look to Light Control', () => {
    expect(labels(tabOrder(shell!.roots.stage))).toEqual(['Look', 'Light Control']);
    const look = document.querySelector('.shell-pill--look')!;
    expect(look.nextElementSibling).toBe(document.getElementById('shell-light-row'));
  });
});
