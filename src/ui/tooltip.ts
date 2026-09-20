// Single page-level tooltip component.
// Positioned via getBoundingClientRect so it is never clipped by scrolling panels.
// Links anchor and tooltip with aria-describedby while active.

import './tooltip.css';

export interface TooltipHandle {
  dispose(): void;
}

const TOOLTIP_ID = 'a11y-tooltip';
const VIEWPORT_PADDING_PX = 8;
const ANCHOR_GAP_PX = 6;

/**
 * One tooltip element for the page: any element with data-tooltip shows it on hover and on focus,
 * hides it on leave, blur and Escape; aria-describedby links them while shown.
 */
export function installTooltips(root: HTMLElement): TooltipHandle {
  const tooltip = document.createElement('div');
  tooltip.id = TOOLTIP_ID;
  tooltip.className = 'a11y-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  root.appendChild(tooltip);

  let activeAnchor: HTMLElement | null = null;
  let previousDescribedBy: string | null = null;

  function updatePosition(anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const tipWidth = tooltip.offsetWidth;
    const tipHeight = tooltip.offsetHeight;

    let x = rect.left + rect.width / 2 - tipWidth / 2;
    const maxX = window.innerWidth - tipWidth - VIEWPORT_PADDING_PX;
    x = Math.max(VIEWPORT_PADDING_PX, Math.min(x, maxX));

    let y = rect.top - tipHeight - ANCHOR_GAP_PX;
    if (y < VIEWPORT_PADDING_PX) {
      y = rect.bottom + ANCHOR_GAP_PX;
    }

    tooltip.style.setProperty('--tooltip-x', `${Math.round(x)}px`);
    tooltip.style.setProperty('--tooltip-y', `${Math.round(y)}px`);
  }

  function show(anchor: HTMLElement): void {
    const text = anchor.getAttribute('data-tooltip');
    if (text === null || text.trim() === '') {
      return;
    }

    // A second show on the same anchor (pointerover after focusin, say) must not re-read
    // aria-describedby: it would store the tooltip's own id and hide() would leave it dangling.
    if (activeAnchor === anchor) {
      updatePosition(anchor);
      return;
    }

    if (activeAnchor !== null) {
      hide();
    }

    activeAnchor = anchor;
    previousDescribedBy = anchor.getAttribute('aria-describedby');
    if (previousDescribedBy === null) {
      anchor.setAttribute('aria-describedby', TOOLTIP_ID);
    } else if (!previousDescribedBy.split(' ').includes(TOOLTIP_ID)) {
      anchor.setAttribute('aria-describedby', `${previousDescribedBy} ${TOOLTIP_ID}`);
    }

    tooltip.textContent = text;
    tooltip.hidden = false;
    updatePosition(anchor);
  }

  function hide(): void {
    if (activeAnchor === null) {
      return;
    }

    if (previousDescribedBy === null) {
      activeAnchor.removeAttribute('aria-describedby');
    } else {
      activeAnchor.setAttribute('aria-describedby', previousDescribedBy);
    }

    activeAnchor = null;
    previousDescribedBy = null;
    tooltip.hidden = true;
    tooltip.textContent = '';
  }

  const controller = new AbortController();
  const signal = controller.signal;

  function findAnchor(node: EventTarget | null): HTMLElement | null {
    if (node instanceof Element) {
      return node.closest<HTMLElement>('[data-tooltip]');
    }
    return null;
  }

  root.addEventListener(
    'pointerover',
    (event) => {
      const anchor = findAnchor(event.target);
      if (anchor !== null) {
        show(anchor);
      }
    },
    { signal },
  );

  root.addEventListener(
    'pointerout',
    (event) => {
      if (activeAnchor === null) {
        return;
      }
      const related = event.relatedTarget;
      if (related instanceof Node && activeAnchor.contains(related)) {
        return;
      }
      hide();
    },
    { signal },
  );

  root.addEventListener(
    'focusin',
    (event) => {
      const anchor = findAnchor(event.target);
      if (anchor !== null) {
        show(anchor);
      }
    },
    { signal },
  );

  root.addEventListener(
    'focusout',
    (event) => {
      if (activeAnchor === null) {
        return;
      }
      const related = event.relatedTarget;
      if (related instanceof Node && activeAnchor.contains(related)) {
        return;
      }
      hide();
    },
    { signal },
  );

  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && activeAnchor !== null) {
        hide();
      }
    },
    { signal },
  );

  window.addEventListener(
    'scroll',
    () => {
      if (activeAnchor !== null) {
        updatePosition(activeAnchor);
      }
    },
    { signal, passive: true, capture: true },
  );

  return {
    dispose(): void {
      controller.abort();
      hide();
      tooltip.remove();
    },
  };
}
