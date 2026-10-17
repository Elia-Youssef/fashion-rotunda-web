import { afterEach, beforeEach, vi } from 'vitest';

import { markFirstFrame } from '../../src/proof/marks';
import type { CatalogLook } from '../../src/catalog/catalog';
import { mountProductCard, variantDisplayName } from '../../src/ui/product-card';
import type { ProductCardActions, ProductCardHandle } from '../../src/ui/product-card';

// The product-card harness shared by the chrome-card suites: a fresh panel root per test and the
// one live card, disposed after it. The hooks register when this module loads, so every suite
// that imports the harness runs them, and Vitest's per-file isolation gives each suite its own
// root and card slot.

export function makeLook(id: string, name: string, variants: string[]): CatalogLook {
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

export const LOOK = makeLook('wallis-dress', 'Wallis Dress', ['base', 'light', 'dark']);
export const OTHER = makeLook('zoot-suit', 'Zoot Suit', ['base', 'light', 'dark']);

export let root: HTMLElement;
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

export function actions(): ProductCardActions {
  return {
    rotate: vi.fn(),
    reset: vi.fn(),
    material: vi.fn(),
  };
}

export interface MountOverrides {
  look?: CatalogLook | null;
  variant?: string | null;
  handlers?: ProductCardActions;
  thumbnailUrl?: (look: CatalogLook) => string;
}

export function mount(overrides: MountOverrides = {}): ProductCardHandle {
  card = mountProductCard(root, {
    look: 'look' in overrides ? overrides.look : LOOK,
    variant: overrides.variant ?? 'base',
    thumbnailUrl: overrides.thumbnailUrl ??
      ((look: CatalogLook): string => `/content/${look.thumbnail ?? ''}`),
    actions: overrides.handlers ?? actions(),
  });
  return card;
}

/** Drops the tracked card after a test disposed it by hand, so teardown does not dispose twice. */
export function retireCard(): void {
  card = null;
}

export function button(label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('.product-card__action')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

export function swatch(variant: string): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>(
    `.product-card__swatch[aria-label="${variantDisplayName(variant)}"]`,
  );
  if (!found) throw new Error(`no swatch for ${variant}`);
  return found;
}

export function swatchNames(): string[] {
  return [...root.querySelectorAll('.product-card__swatch')].map(
    (element) => element.getAttribute('aria-label') ?? '',
  );
}
