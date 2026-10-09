// The look strip: one button per catalogue look, down the canvas's left edge, after the thumbnail
// column of the Unreal original. The module is DOM only: it renders what it is given and reports
// clicks upward; which look loads, and what busy means, belong to the chrome module.

import './catalog-strip.css';

import type { CatalogLook } from '../catalog/catalog';

// Keep the focus handler's axis in step with the column breakpoint in catalog-strip.css.
const DESKTOP_RAIL_QUERY = '(min-width: 1200px)';

type HorizontalRect = Pick<DOMRectReadOnly, 'left' | 'right'>;

/**
 * Returns the nearest scroll position that reveals the thumbnail and its CSS scroll margins.
 * Container edges are its visible client area, not its border box. An oversized thumbnail cannot
 * fit: keep it still when it spans both edges, otherwise bring its nearer edge into view.
 * The scroll container clamps the result to its own scrollable range.
 */
export function focusedThumbnailScrollLeft(
  container: HorizontalRect,
  thumbnail: HorizontalRect,
  margin: { left: number; right: number },
  scrollLeft: number,
): number {
  const left = thumbnail.left - margin.left;
  const right = thumbnail.right + margin.right;
  const before = left < container.left;
  const after = right > container.right;
  if (before === after) return scrollLeft;

  const oversized = right - left > container.right - container.left;
  const delta = before !== oversized ? left - container.left : right - container.right;
  return scrollLeft + delta;
}

export interface CatalogStripOptions {
  looks: CatalogLook[];
  thumbnailUrl: (look: CatalogLook) => string;
  current: string | null;
  onSelect: (id: string) => void;
}

export interface CatalogStripHandle {
  /** Marks the active thumbnail, aria-current="true"; null clears the mark everywhere. */
  setCurrent(id: string | null): void;
  /** The look being fetched: aria-busy on that item, removed from every other. */
  setBusy(id: string | null): void;
  dispose(): void;
}

/**
 * Fills the given root, index.html's <nav id="looks">, with the thumbnail list. The root is the
 * nav itself, so the label is set here rather than trusted from the page: the element and its
 * meaning cannot drift apart. A look without a thumbnail gets a labelled empty box rather than an
 * <img> with an empty src, which resolves to the page's own URL and a 404 in the console.
 */
export function mountCatalogStrip(
  root: HTMLElement,
  options: CatalogStripOptions,
): CatalogStripHandle {
  root.setAttribute('aria-label', 'Looks');

  const list = document.createElement('ul');
  list.className = 'catalog-strip';

  const buttons = new Map<string, HTMLButtonElement>();

  // One controller for every listener, so dispose revokes them all at once: removing the elements
  // alone would leave a caller-held button able to fire its handler.
  const listeners = new AbortController();

  for (const look of options.looks) {
    const item = document.createElement('li');
    item.className = 'catalog-strip__item';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'catalog-strip__button';
    button.dataset.look = look.id;
    button.dataset.tooltip = `Show ${look.name}`;

    const url = options.thumbnailUrl(look);
    if (url !== '') {
      const image = document.createElement('img');
      image.className = 'catalog-strip__thumb';
      image.src = url;
      // The hidden label below carries the name; an empty alt keeps the thumbnail decorative so
      // a screen reader does not read the look name twice.
      image.alt = '';
      button.appendChild(image);
    } else {
      const empty = document.createElement('span');
      empty.className = 'catalog-strip__empty';
      // The name is on the hidden label below; the box needs no text of its own.
      empty.setAttribute('aria-hidden', 'true');
      button.appendChild(empty);
    }

    // The name alongside the image, hidden from the eye but present for a screen reader, so the
    // button says more than "wallis-dress" ever could.
    const label = document.createElement('span');
    label.className = 'catalog-strip__label';
    label.textContent = look.name;
    button.appendChild(label);

    button.addEventListener(
      'focus',
      () => {
        if (matchMedia(DESKTOP_RAIL_QUERY).matches) return;

        const box = root.getBoundingClientRect();
        const left = box.left + root.clientLeft;
        const style = getComputedStyle(button);
        const target = focusedThumbnailScrollLeft(
          { left, right: left + root.clientWidth },
          button.getBoundingClientRect(),
          {
            left: parseFloat(style.scrollMarginLeft) || 0,
            right: parseFloat(style.scrollMarginRight) || 0,
          },
          root.scrollLeft,
        );
        if (target !== root.scrollLeft) {
          // Only this nav scrolls, instantly even if CSS enables smooth scrolling elsewhere.
          root.scrollTo({ left: target, behavior: 'instant' });
        }
      },
      { signal: listeners.signal },
    );

    button.addEventListener(
      'click',
      () => {
        options.onSelect(look.id);
      },
      { signal: listeners.signal },
    );

    buttons.set(look.id, button);
    item.appendChild(button);
    list.appendChild(item);
  }

  root.appendChild(list);

  function mark(attribute: string, id: string | null): void {
    for (const [lookId, button] of buttons) {
      if (lookId === id) {
        button.setAttribute(attribute, 'true');
      } else {
        button.removeAttribute(attribute);
      }
    }
  }

  const handle: CatalogStripHandle = {
    setCurrent(id: string | null): void {
      mark('aria-current', id);
    },
    setBusy(id: string | null): void {
      mark('aria-busy', id);
    },
    dispose(): void {
      listeners.abort();
      list.remove();
      root.removeAttribute('aria-label');
    },
  };

  handle.setCurrent(options.current);
  return handle;
}
