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
// Allow a pointer to cross the existing gap without briefly removing the text.
const HOVER_TRANSIT_DELAY_MS = 150;

/**
 * Whether a focus should show its tooltip: only when the browser draws the focus ring, that is,
 * keyboard focus or script focus that follows keyboard use. A mouse click that opens a panel and
 * moves focus into it would otherwise cover the panel with a tooltip every time. A runtime that
 * cannot parse :focus-visible keeps the old behaviour and shows it.
 */
function focusIsVisible(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return true;
  }
  try {
    return target.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * One tooltip element for the page: any element with data-tooltip shows it on hover and on
 * keyboard-visible focus, keeps it across both hover surfaces, and dismisses on Escape.
 * aria-describedby links them while shown.
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
  let hoveredAnchor: HTMLElement | null = null;
  let focusedAnchor: HTMLElement | null = null;
  let dismissedAnchor: HTMLElement | null = null;
  let transitTimer: number | null = null;

  function cancelTransit(): void {
    if (transitTimer !== null) {
      window.clearTimeout(transitTimer);
      transitTimer = null;
    }
  }

  function startTransit(): void {
    // Moving outside both surfaces must not keep restarting the grace period.
    if (transitTimer !== null) {
      return;
    }
    transitTimer = window.setTimeout(() => {
      transitTimer = null;
      hoveredAnchor = null;
      reconcile();
    }, HOVER_TRANSIT_DELAY_MS);
  }

  function containsPointer(rect: DOMRect, event: PointerEvent): boolean {
    return event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
  }

  function onPointerMove(event: PointerEvent): void {
    if (activeAnchor === null) {
      return;
    }
    const anchor = findAnchor(event.target);
    // The control under the pointer wins even where the non-interactive tooltip overlaps it.
    if (anchor !== null && root.contains(anchor) && anchor !== activeAnchor) {
      cancelTransit();
      dismissedAnchor = null;
      hoveredAnchor = anchor;
      reconcile(anchor);
      return;
    }
    if (containsPointer(activeAnchor.getBoundingClientRect(), event)
      || containsPointer(tooltip.getBoundingClientRect(), event)) {
      cancelTransit();
      hoveredAnchor = activeAnchor;
    } else {
      startTransit();
    }
  }

  function reconcile(preferredAnchor?: HTMLElement): void {
    // The latest deliberate entry wins when hover and focus belong to different controls.
    const activeOwned = activeAnchor !== null && (activeAnchor === hoveredAnchor || activeAnchor === focusedAnchor);
    const anchor = preferredAnchor ?? (activeOwned ? activeAnchor : hoveredAnchor ?? focusedAnchor);
    if (anchor !== null && anchor !== dismissedAnchor) {
      show(anchor);
    } else {
      hide();
    }
    if (hoveredAnchor === null && focusedAnchor === null) {
      dismissedAnchor = null;
    }
  }

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
    document.addEventListener('pointermove', onPointerMove);
  }

  function hide(): void {
    if (activeAnchor === null) {
      return;
    }

    document.removeEventListener('pointermove', onPointerMove);
    cancelTransit();
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
        cancelTransit();
        const related = event.relatedTarget;
        const fromPair = related instanceof Node && (anchor.contains(related) || tooltip.contains(related));
        if (!fromPair) dismissedAnchor = null;
        hoveredAnchor = anchor;
        reconcile(anchor);
      }
    },
    { signal },
  );

  root.addEventListener(
    'pointerout',
    (event) => {
      if (hoveredAnchor === null) {
        return;
      }
      const source = event.target;
      if (!(source instanceof Node) || !hoveredAnchor.contains(source)) {
        return;
      }
      const related = event.relatedTarget;
      if (related instanceof Node && hoveredAnchor.contains(related)) {
        return;
      }
      startTransit();
    },
    { signal },
  );

  root.addEventListener(
    'focusin',
    (event) => {
      const anchor = findAnchor(event.target);
      if (anchor !== null && focusIsVisible(event.target)) {
        const related = event.relatedTarget;
        if (!(related instanceof Node) || !anchor.contains(related)) dismissedAnchor = null;
        focusedAnchor = anchor;
        reconcile(anchor);
      }
    },
    { signal },
  );

  root.addEventListener(
    'focusout',
    (event) => {
      if (focusedAnchor === null) {
        return;
      }
      const related = event.relatedTarget;
      if (related instanceof Node && focusedAnchor.contains(related)) {
        return;
      }
      focusedAnchor = null;
      reconcile();
    },
    { signal },
  );

  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && activeAnchor !== null) {
        dismissedAnchor = activeAnchor;
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
      cancelTransit();
      hide();
      tooltip.remove();
    },
  };
}
