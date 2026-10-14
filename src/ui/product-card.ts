// The product card: the panel that names the look on the plinth, describes it, carries the three
// actions (Rotate, Reset, Material) and offers the mannequin swatches. It is a dumb view:
// every action leaves through ProductCardActions and every state change arrives through the
// handle, so the chrome module stays the one place that talks to the showroom.

import './product-card.css';
import { afterFirstFrame } from '../proof/marks';

import type { CatalogLook } from '../catalog/catalog';

export interface ProductCardActions {
  /** Toggles the turntable. */
  rotate(): void;
  reset(): void;
  /** A swatch was clicked, with the variant's name. */
  material(name: string): void;
}

export interface ProductCardOptions {
  look: CatalogLook | null;
  variant: string | null;
  thumbnailUrl: (look: CatalogLook) => string;
  actions: ProductCardActions;
}

export interface ProductCardHandle {
  /** Re-renders name, text, thumbnail, swatches for a new look. */
  setLook(look: CatalogLook | null, variant: string | null): void;
  /** Marks the active swatch only. */
  setVariant(name: string | null): void;
  /** The Rotate button reads aria-pressed. */
  setRotating(on: boolean): void;
  dispose(): void;
}

/** Ids must be unique per document, so two cards on one page cannot collide on aria-controls. */
let cardSerial = 0;

// The swatches keep the catalogue's variant ids in URLs and data attributes, but name themselves
// in prose. One map, so the radios and the live-region announcement read the same words.
const VARIANT_DISPLAY_NAMES = new Map<string, string>([
  ['base', 'Default'],
  ['light', 'Light'],
  ['dark', 'Dark charcoal'],
]);

/** The swatch's accessible name for a variant id; an id the map does not know keeps its id. */
export function variantDisplayName(variant: string): string {
  return VARIANT_DISPLAY_NAMES.get(variant) ?? variant;
}

export function mountProductCard(root: HTMLElement, options: ProductCardOptions): ProductCardHandle {
  cardSerial += 1;
  const swatchesId = `product-card-${cardSerial}-swatches`;

  const card = document.createElement('section');
  card.className = 'product-card';
  card.setAttribute('aria-label', 'Look');

  const head = document.createElement('div');
  head.className = 'product-card__head';

  const thumb = document.createElement('img');
  thumb.className = 'product-card__thumb';
  const thumbEmpty = document.createElement('span');
  thumbEmpty.className = 'product-card__thumb-empty';
  thumbEmpty.setAttribute('aria-hidden', 'true');

  const heading = document.createElement('div');
  heading.className = 'product-card__heading';
  const name = document.createElement('h2');
  name.className = 'product-card__name';
  const description = document.createElement('p');
  description.className = 'product-card__description';
  const source = document.createElement('a');
  source.className = 'product-card__source';
  source.textContent = 'Source';
  source.setAttribute('aria-label', 'Source (opens in a new tab)');
  source.target = '_blank';
  source.rel = 'noopener noreferrer';
  heading.append(name, description, source);

  head.append(thumb, thumbEmpty, heading);
  card.appendChild(head);

  const actions = document.createElement('div');
  actions.className = 'product-card__actions';
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', 'Look actions');

  function action(label: string, kind: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'product-card__action';
    button.dataset['action'] = kind;
    button.textContent = label;
    actions.appendChild(button);
    return button;
  }

  const rotateButton = action('Rotate', 'rotate');
  rotateButton.dataset['tooltip'] = 'Rotate the look';
  const resetButton = action('Reset', 'reset');
  resetButton.dataset['tooltip'] = 'Reset camera and mannequin';
  // Material toggles the swatch row; the row starts open, matching the Unreal reference.
  const materialButton = action('Material', 'material');
  materialButton.dataset['tooltip'] = 'Show mannequin swatches';
  materialButton.setAttribute('aria-controls', swatchesId);

  card.appendChild(actions);

  const swatches = document.createElement('div');
  swatches.className = 'product-card__swatches';
  swatches.id = swatchesId;
  swatches.setAttribute('role', 'radiogroup');
  swatches.setAttribute('aria-label', 'Mannequin material');
  card.appendChild(swatches);

  // The card leads the side panel, above the badge, so it is prepended rather than appended.
  root.prepend(card);

  // Fixed controls live for the card; swatch listeners live for one rendered look.
  const listeners = new AbortController();
  const signal = listeners.signal;
  let swatchListeners: AbortController | null = null;
  let thumbnailAssignment: AbortController | null = null;

  rotateButton.addEventListener(
    'click',
    () => {
      options.actions.rotate();
    },
    { signal },
  );
  resetButton.addEventListener(
    'click',
    () => {
      options.actions.reset();
    },
    { signal },
  );
  materialButton.addEventListener(
    'click',
    () => {
      setSwatchesCollapsed(!swatchesCollapsed);
    },
    { signal },
  );

  /** The swatch buttons of the current look, by variant name. */
  let swatchButtons = new Map<string, HTMLButtonElement>();
  let swatchesCollapsed = false;

  function setSwatchesCollapsed(collapsed: boolean): void {
    swatchesCollapsed = collapsed;
    swatches.hidden = collapsed;
    materialButton.setAttribute('aria-expanded', String(!collapsed));
  }

  function swatchTooltip(variant: string): string {
    if (variant === 'light') {
      return 'Mannequin in light tone';
    }
    if (variant === 'dark') {
      return 'Mannequin in dark charcoal tone';
    }
    if (variant === 'base') {
      return 'Mannequin in default tone';
    }
    return `Mannequin in ${variant} tone`;
  }

  function retireSwatches(): void {
    swatchListeners?.abort();
    swatchListeners = null;
    for (const button of swatchButtons.values()) {
      button.remove();
    }
    swatchButtons = new Map<string, HTMLButtonElement>();
  }

  function renderSwatches(look: CatalogLook): void {
    swatchListeners = new AbortController();
    for (const variant of look.variants) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `product-card__swatch product-card__swatch--${variant}`;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', variantDisplayName(variant));
      button.dataset['tooltip'] = swatchTooltip(variant);
      button.tabIndex = -1;
      button.addEventListener(
        'click',
        () => {
          handle.setVariant(variant);
          options.actions.material(variant);
        },
        { signal: swatchListeners.signal },
      );
      swatchButtons.set(variant, button);
      swatches.appendChild(button);
    }
  }

  // Single tab stop: arrow keys move the check and apply the swatch, Home and End go to the ends.
  swatches.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      // The variant comes from the map's key, never from the button's label: aria-label is display
      // text, and rewording it must not silently change which material the arrow keys apply.
      const entries = Array.from(swatchButtons.entries());
      if (entries.length === 0) {
        return;
      }
      const active = document.activeElement;
      const currentIndex = entries.findIndex(([, button]) => button === active);
      if (currentIndex === -1) {
        return;
      }

      let nextIndex = -1;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        nextIndex = (currentIndex + 1) % entries.length;
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        nextIndex = (currentIndex - 1 + entries.length) % entries.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = entries.length - 1;
      }

      if (nextIndex !== -1) {
        event.preventDefault();
        const [variant, nextButton] = entries[nextIndex];
        handle.setVariant(variant);
        options.actions.material(variant);
        nextButton.focus();
      }
    },
    { signal },
  );

  function renderLook(look: CatalogLook | null): void {
    retireSwatches();
    thumbnailAssignment?.abort();
    thumbnailAssignment = new AbortController();
    thumb.removeAttribute('src');
    source.hidden = look?.sourceUrl === undefined;
    if (look?.sourceUrl !== undefined) source.href = look.sourceUrl;
    else source.removeAttribute('href');
    if (look === null) {
      name.textContent = '';
      description.textContent = 'No look on the plinth yet.';
      thumb.hidden = true;
      thumbEmpty.hidden = false;
      return;
    }
    name.textContent = look.name;
    description.textContent = look.description;
    const url = options.thumbnailUrl(look);
    thumb.hidden = true;
    thumbEmpty.hidden = false;
    if (url !== '') {
      afterFirstFrame(() => {
        thumb.src = url;
        thumb.hidden = false;
        thumbEmpty.hidden = true;
      }, thumbnailAssignment.signal);
      thumb.alt = look.name;
    }
    renderSwatches(look);
  }

  const handle: ProductCardHandle = {
    setLook(look: CatalogLook | null, variant: string | null): void {
      if (signal.aborted) return;
      const active = document.activeElement;
      const ownedFocus = active !== null && swatches.contains(active);
      const focusedVariant = [...swatchButtons].find(([, button]) => button === active)?.[0];
      renderLook(look);
      handle.setVariant(variant);
      // A new look re-renders the row through renderLook, which returns it to the page's default.
      setSwatchesCollapsed(false);
      if (ownedFocus) {
        // Restore by identity, not row position. Empty rows return to their disclosure control.
        const equivalent = focusedVariant === undefined ? undefined : swatchButtons.get(focusedVariant);
        const checked = [...swatchButtons.values()].find((button) => button.getAttribute('aria-checked') === 'true');
        const destination = equivalent ?? checked ?? swatchButtons.values().next().value ?? materialButton;
        destination.focus();
      }
    },
    setVariant(variant: string | null): void {
      let checkedFound = false;
      for (const [variantName, button] of swatchButtons) {
        if (variantName === variant) {
          button.setAttribute('aria-checked', 'true');
          button.tabIndex = 0;
          checkedFound = true;
        } else {
          button.setAttribute('aria-checked', 'false');
          button.tabIndex = -1;
        }
      }
      if (!checkedFound) {
        const first = swatchButtons.values().next().value;
        if (first !== undefined) {
          // A name this look does not carry must still leave the group with one checked member,
          // or the arrow keys have no starting point. An explicit null is a clear, not a miss,
          // so it only moves the tab stop.
          if (variant !== null) {
            first.setAttribute('aria-checked', 'true');
          }
          first.tabIndex = 0;
        }
      }
    },
    setRotating(on: boolean): void {
      rotateButton.setAttribute('aria-pressed', String(on));
    },
    dispose(): void {
      listeners.abort();
      thumbnailAssignment?.abort();
      retireSwatches();
      card.remove();
    },
  };

  renderLook(options.look);
  handle.setVariant(options.variant);
  handle.setRotating(false);
  setSwatchesCollapsed(false);
  return handle;
}
