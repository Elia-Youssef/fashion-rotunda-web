// The product card: the panel that names the look on the plinth, describes it, carries the four
// actions (Rotate, Audio, Reset, Material) and offers the mannequin swatches. It is a dumb view:
// every action leaves through ProductCardActions and every state change arrives through the
// handle, so the chrome module stays the one place that talks to the showroom.

import './product-card.css';

import type { CatalogLook } from '../catalog/catalog';

export interface ProductCardActions {
  /** Toggles the turntable. */
  rotate(): void;
  /** Stub until the audio files are wired: the card starts with the button disabled. */
  audio(): void;
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
  setLook(look: CatalogLook, variant: string | null): void;
  /** Marks the active swatch only. */
  setVariant(name: string | null): void;
  /** The Rotate button reads aria-pressed. */
  setRotating(on: boolean): void;
  setAudioAvailable(on: boolean): void;
  dispose(): void;
}

/** Ids must be unique per document, so two cards on one page cannot collide on aria-controls. */
let cardSerial = 0;

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
  heading.append(name, description);

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
    button.dataset.action = kind;
    button.textContent = label;
    actions.appendChild(button);
    return button;
  }

  const rotateButton = action('Rotate', 'rotate');
  const audioButton = action('Audio', 'audio');
  const resetButton = action('Reset', 'reset');
  // Material opens the swatch row when it is collapsed; the row starts open, matching the Unreal
  // still, so the button is mostly the guarantee the row can always be reached.
  const materialButton = action('Material', 'material');
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

  // One controller for every listener, so dispose revokes them all at once.
  const listeners = new AbortController();
  const signal = listeners.signal;

  rotateButton.addEventListener(
    'click',
    () => {
      options.actions.rotate();
    },
    { signal },
  );
  audioButton.addEventListener(
    'click',
    () => {
      options.actions.audio();
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
      // Open-only by design: the button is titled after a tray that opens, not a toggle.
      setSwatchesCollapsed(false);
    },
    { signal },
  );

  /** The swatch buttons of the current look, by variant name. */
  let swatchButtons = new Map<string, HTMLButtonElement>();

  function setSwatchesCollapsed(collapsed: boolean): void {
    swatches.hidden = collapsed;
    materialButton.setAttribute('aria-expanded', String(!collapsed));
  }

  function renderSwatches(look: CatalogLook): void {
    for (const button of swatchButtons.values()) {
      button.remove();
    }
    swatchButtons = new Map<string, HTMLButtonElement>();
    for (const variant of look.variants) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `product-card__swatch product-card__swatch--${variant}`;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', variant);
      button.title = variant;
      button.addEventListener(
        'click',
        () => {
          options.actions.material(variant);
        },
        { signal },
      );
      swatchButtons.set(variant, button);
      swatches.appendChild(button);
    }
  }

  function renderLook(look: CatalogLook | null): void {
    if (look === null) {
      name.textContent = '';
      description.textContent = 'No look on the plinth yet.';
      thumb.hidden = true;
      thumbEmpty.hidden = false;
      for (const button of swatchButtons.values()) {
        button.remove();
      }
      swatchButtons = new Map<string, HTMLButtonElement>();
      return;
    }
    name.textContent = look.name;
    description.textContent = look.description;
    const url = options.thumbnailUrl(look);
    thumb.hidden = url === '';
    thumbEmpty.hidden = url !== '';
    if (url !== '') {
      thumb.src = url;
      thumb.alt = look.name;
    }
    renderSwatches(look);
  }

  const handle: ProductCardHandle = {
    setLook(look: CatalogLook, variant: string | null): void {
      renderLook(look);
      handle.setVariant(variant);
      // A new look re-renders the row through renderLook, which returns it to the page's default.
      setSwatchesCollapsed(false);
    },
    setVariant(variant: string | null): void {
      for (const [variantName, button] of swatchButtons) {
        if (variantName === variant) {
          button.setAttribute('aria-checked', 'true');
        } else {
          button.setAttribute('aria-checked', 'false');
        }
      }
    },
    setRotating(on: boolean): void {
      rotateButton.setAttribute('aria-pressed', String(on));
    },
    setAudioAvailable(on: boolean): void {
      audioButton.disabled = !on;
    },
    dispose(): void {
      listeners.abort();
      card.remove();
    },
  };

  renderLook(options.look);
  handle.setVariant(options.variant);
  handle.setRotating(false);
  setSwatchesCollapsed(false);
  return handle;
}
