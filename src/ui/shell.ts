// The UI shell: the one module that owns the page's layout state. It finds the roots index.html
// declares by id, mounts the furniture the breakpoints need (the Light Control disclosure, the
// Look pill, the sheet handles and close buttons) and watches the width, so which regions are
// sheets and which are columns follows the breakpoint rather than any other decision.

import './shell.css';

export type Breakpoint = 'phone' | 'tablet' | 'desktop';

/** phone: below 768 px, tablet: 768 to 1199, desktop: 1200 and up; the same numbers as the CSS. */
export const BREAKPOINTS: Readonly<Record<Breakpoint, { min: number }>> = {
  phone: { min: 0 },
  tablet: { min: 768 },
  desktop: { min: 1200 },
};

// Width names stay stable for callers, but a wide screen that is this short has no room for the
// tablet grid's scene, panel and proof rows together. It therefore uses the phone sheets while
// continuing to report its width breakpoint as tablet or desktop.
const SHORT_VIEWPORT_MAX_HEIGHT = 599;

export function breakpointFor(width: number): Breakpoint {
  if (width >= BREAKPOINTS.desktop.min) {
    return 'desktop';
  }
  if (width >= BREAKPOINTS.tablet.min) {
    return 'tablet';
  }
  return 'phone';
}

export interface ShellRoots {
  /** the title, the music switch, the camera's mode switch */
  header: HTMLElement;
  /** nav#looks, the thumbnail strip */
  rail: HTMLElement;
  /** the element that holds canvas#scene and nothing else drawn */
  stage: HTMLElement;
  /** the product card and the share block */
  card: HTMLElement;
  /** the light panel, collapsible */
  lightPanel: HTMLElement;
  /** the footer strip: the backend badge and the proof panel */
  proof: HTMLElement;
}

export interface ShellHandle {
  readonly roots: ShellRoots;
  readonly breakpoint: Breakpoint;
  /** The Light Control disclosure; also drives the phone sheet. */
  setLightPanelOpen(open: boolean): void;
  readonly lightPanelOpen: boolean;
  /** The card sheet on phones; a no-op that reports true elsewhere. */
  setCardOpen(open: boolean): void;
  readonly cardOpen: boolean;
  onBreakpointChange(listener: (breakpoint: Breakpoint) => void): () => void;
  dispose(): void;
}

function requireRoot(doc: Document, id: string, what: string): HTMLElement {
  const element = doc.getElementById(id);
  if (element === null) {
    throw new Error(`index.html has no ${what} (#${id}).`);
  }
  return element;
}

export function mountShell(doc: Document): ShellHandle {
  const roots: ShellRoots = {
    header: requireRoot(doc, 'shell-header', 'page header'),
    rail: requireRoot(doc, 'looks', 'looks strip'),
    stage: requireRoot(doc, 'shell-stage', 'canvas stage'),
    card: requireRoot(doc, 'shell-card', 'product card root'),
    lightPanel: requireRoot(doc, 'shell-light-panel', 'light panel root'),
    proof: requireRoot(doc, 'shell-proof', 'proof strip'),
  };

  // The light row is the panel root's own container in index.html: the pill when closed, the
  // sheet when open. The shell drives it entirely through data attributes and hidden. The
  // instanceof check gives the closure below a row that is HTMLElement by declaration, not by
  // narrowing, which TypeScript does not carry into hoisted functions.
  const rowParent = roots.lightPanel.parentElement;
  if (!(rowParent instanceof HTMLElement)) {
    throw new Error('index.html has no light row around #shell-light-panel.');
  }
  const row: HTMLElement = rowParent;

  const listeners = new AbortController();
  const signal = listeners.signal;

  // One button, two lives: the pill on the phone, the disclosure beside the panel above it.
  // aria-controls names the panel root, which is the element that gains and loses hidden.
  const lightToggle = doc.createElement('button');
  lightToggle.type = 'button';
  lightToggle.id = 'shell-light-toggle';
  lightToggle.className = 'shell-light-toggle';
  lightToggle.textContent = 'Light Control';
  lightToggle.setAttribute('aria-controls', 'shell-light-panel');
  lightToggle.addEventListener(
    'click',
    () => {
      setLightPanelOpen(!lightOpen, lightToggle);
    },
    { signal },
  );
  row.prepend(lightToggle);

  // The Look pill opens the card sheet; above the phone width CSS hides it and setCardOpen is a
  // no-op, so it never fires there.
  const lookPill = doc.createElement('button');
  lookPill.type = 'button';
  lookPill.className = 'shell-pill shell-pill--look';
  lookPill.textContent = 'Look';
  lookPill.setAttribute('aria-controls', 'shell-card');
  lookPill.addEventListener(
    'click',
    () => {
      setCardOpen(true, lookPill);
    },
    { signal },
  );
  roots.stage.appendChild(lookPill);

  /** The handle bar and close button of one sheet, wrapped so the shell can hide both together. */
  function sheetChrome(sheet: HTMLElement, close: () => void): HTMLElement {
    const chrome = doc.createElement('div');
    chrome.className = 'shell-sheet__chrome';
    const handle = doc.createElement('div');
    handle.className = 'shell-sheet__handle';
    handle.setAttribute('aria-hidden', 'true');
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'shell-sheet__close';
    button.textContent = 'x';
    button.setAttribute('aria-label', 'Close');
    button.addEventListener('click', close, { signal });
    chrome.append(handle, button);
    sheet.appendChild(chrome);
    return chrome;
  }

  const cardChrome = sheetChrome(roots.card, () => {
    dismissCard();
  });
  const lightChrome = sheetChrome(row, () => {
    dismissLightPanel();
  });

  const view = doc.defaultView;
  let breakpoint = breakpointFor(view === null ? 0 : view.innerWidth);
  let shortViewport =
    view !== null &&
    view.innerWidth >= BREAKPOINTS.tablet.min &&
    view.innerHeight <= SHORT_VIEWPORT_MAX_HEIGHT;
  function sheetMode(): boolean {
    return breakpoint === 'phone' || shortViewport;
  }
  // The defaults, never persisted: the Light Control drawer starts closed on every breakpoint —
  // the hero reference ships it shut — and the card sheet starts closed where sheets exist at
  // all. Opening is always the visitor's explicit act, through the toggle or setLightPanelOpen.
  let lightOpen = false;
  let cardSheetOpen = false;

  // A hidden close button must not survive as a transparent hit target or a tab stop. `hidden`
  // supplies the browser's visual and accessibility semantics; inert and the -1 tab index make
  // the contract explicit even if a future sheet style changes the element's display property.
  function setSheetChromeVisible(chrome: HTMLElement, visible: boolean): void {
    const close = chrome.querySelector<HTMLButtonElement>('.shell-sheet__close');
    chrome.hidden = !visible;
    chrome.inert = !visible;
    chrome.setAttribute('aria-hidden', String(!visible));
    if (close !== null) {
      close.tabIndex = visible ? 0 : -1;
    }
  }

  let lightInvoker: HTMLElement | null = null;
  let cardInvoker: HTMLElement | null = null;

  function focusInvoker(invoker: HTMLElement | null, fallback: HTMLElement): void {
    const target =
      invoker !== null && invoker.isConnected && invoker.closest('[hidden]') === null
        ? invoker
        : fallback;
    target.focus();
  }

  function focusVisibleCardControl(): void {
    const control = roots.card.querySelector<HTMLElement>(
      'button:not([disabled]):not(.shell-sheet__close), [href], input:not([disabled]), select:not([disabled]), [tabindex="0"]',
    );
    if (control !== null && control.closest('[hidden]') === null) {
      control.focus();
    } else {
      lightToggle.focus();
    }
  }

  function focusCardSheetClose(): void {
    const close = cardChrome.querySelector<HTMLButtonElement>('.shell-sheet__close');
    if (close !== null && !close.hidden && !close.inert) {
      close.focus();
      return;
    }
    focusVisibleCardControl();
  }

  function focusVisibleLightControl(): void {
    const control = roots.lightPanel.querySelector<HTMLElement>(
      'button:not([disabled]):not(.shell-sheet__close), [href], input:not([disabled]), select:not([disabled]), [tabindex="0"]',
    );
    if (control !== null && control.closest('[hidden]') === null) {
      control.focus();
    }
  }

  function apply(): void {
    roots.lightPanel.hidden = !lightOpen;
    lightToggle.setAttribute('aria-expanded', String(lightOpen));
    row.dataset.open = String(lightOpen);
    const sheetUp = sheetMode() && (lightOpen || cardSheetOpen);
    // A phone sheet is modal relative to the thumbnail rail. Leaving the rail merely painted
    // behind the sheet made it look available while the sheet launcher intercepted its hit
    // points. Hide it semantically as well as visually, then restore the exact same rail when
    // the sheet closes or the layout returns to columns.
    roots.rail.hidden = sheetUp;
    roots.rail.inert = sheetUp;
    roots.rail.setAttribute('aria-hidden', String(sheetUp));
    doc.body.toggleAttribute('data-shell-sheet-open', sheetUp);
    if (sheetUp) {
      roots.stage.dataset.sheet = 'true';
    } else {
      delete roots.stage.dataset.sheet;
    }
    roots.card.hidden = sheetMode() && !cardSheetOpen;
    lookPill.hidden = !sheetMode();
    lookPill.setAttribute('aria-expanded', String(sheetMode() && cardSheetOpen));
    setSheetChromeVisible(cardChrome, sheetMode() && cardSheetOpen);
    setSheetChromeVisible(lightChrome, sheetMode() && lightOpen);
  }

  function setLightPanelOpen(open: boolean, invoker: HTMLElement | null = null): void {
    const wasClosed = !lightOpen;
    // One sheet at a time on the phone: opening the lights closes the card.
    if (open && sheetMode() && cardSheetOpen) {
      cardSheetOpen = false;
    }
    if (open && wasClosed) {
      lightInvoker = invoker ?? lightToggle;
    }
    lightOpen = open;
    apply();
    if (open && wasClosed) {
      focusVisibleLightControl();
    }
  }

  function setCardOpen(open: boolean, invoker: HTMLElement | null = null): void {
    // Above the phone width the card is a column, so there is no sheet to open or close.
    if (!sheetMode()) {
      return;
    }
    if (open && lightOpen) {
      lightOpen = false;
    }
    const wasClosed = !cardSheetOpen;
    if (open && wasClosed) {
      cardInvoker = invoker ?? lookPill;
    }
    cardSheetOpen = open;
    apply();
    if (open && wasClosed) {
      // The close button is the sheet's first, always-visible control. Focusing a product action
      // can scroll a short card underneath its absolute close affordance, which strands Escape's
      // pointer equivalent outside the safe rectangle. Keeping the cursor at Close preserves a
      // modal starting point without moving the card's internal scroll position.
      focusCardSheetClose();
    }
  }

  function dismissLightPanel(): void {
    if (!lightOpen) {
      return;
    }
    setLightPanelOpen(false);
    focusInvoker(lightInvoker, lightToggle);
  }

  function dismissCard(): void {
    if (!cardSheetOpen) {
      return;
    }
    setCardOpen(false);
    focusInvoker(cardInvoker, lookPill);
  }

  doc.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (lightOpen) {
        event.preventDefault();
        dismissLightPanel();
      } else if (cardSheetOpen) {
        event.preventDefault();
        dismissCard();
      }
    },
    { signal },
  );

  apply();

  const bpListeners = new Set<(breakpoint: Breakpoint) => void>();

  // jsdom has no matchMedia; the shell then simply stays at the width it mounted with, which is
  // all a document that never resizes needs.
  let stopWatching: (() => void) | null = null;
  if (view !== null && typeof view.matchMedia === 'function') {
    const onChange = (): void => {
      const next = breakpointFor(view.innerWidth);
      const nextShort =
        view.innerWidth >= BREAKPOINTS.tablet.min && view.innerHeight <= SHORT_VIEWPORT_MAX_HEIGHT;
      if (next === breakpoint && nextShort === shortViewport) {
        return;
      }
      const breakpointChanged = next !== breakpoint;
      const wasSheetMode = sheetMode();
      const active = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
      const activeInLightPanel = active !== null && roots.lightPanel.contains(active);
      const activeInLightChrome = active !== null && lightChrome.contains(active);
      const activeInCardChrome = active !== null && cardChrome.contains(active);
      const activeInCardContent =
        active !== null && roots.card.contains(active) && !activeInCardChrome;
      const activeLookPill = active === lookPill;
      breakpoint = next;
      shortViewport = nextShort;
      if (sheetMode() !== wasSheetMode) {
        // Crossing into or out of sheet country resets both disclosures to closed rather than
        // translating one mode's open state into the other's geometry.
        lightOpen = false;
        cardSheetOpen = false;
      }
      apply();
      // A responsive transition may hide the disclosure that currently owns focus. Move focus to
      // its now-visible launcher instead of leaving the keyboard cursor inside hidden content.
      if (
        (activeInLightPanel && roots.lightPanel.hidden) ||
        (activeInLightChrome && lightChrome.hidden)
      ) {
        focusInvoker(lightInvoker, lightToggle);
      } else if (activeInCardContent && roots.card.hidden) {
        focusInvoker(cardInvoker, lookPill);
      } else if (
        (activeInCardChrome && cardChrome.hidden) ||
        (activeLookPill && lookPill.hidden)
      ) {
        focusVisibleCardControl();
      }
      if (breakpointChanged) {
        for (const listener of bpListeners) {
          listener(next);
        }
      }
    };
    const queries = [
      view.matchMedia('(min-width: 768px)'),
      view.matchMedia('(min-width: 1200px)'),
      view.matchMedia('(max-height: 599px)'),
    ];
    for (const query of queries) {
      query.addEventListener('change', onChange);
    }
    stopWatching = (): void => {
      for (const query of queries) {
        query.removeEventListener('change', onChange);
      }
    };
  }

  return {
    roots,
    get breakpoint(): Breakpoint {
      return breakpoint;
    },
    setLightPanelOpen,
    get lightPanelOpen(): boolean {
      return lightOpen;
    },
    setCardOpen,
    get cardOpen(): boolean {
      return sheetMode() ? cardSheetOpen : true;
    },
    onBreakpointChange(listener: (breakpoint: Breakpoint) => void): () => void {
      bpListeners.add(listener);
      return (): void => {
        bpListeners.delete(listener);
      };
    },
    dispose(): void {
      listeners.abort();
      stopWatching?.();
      bpListeners.clear();
      lightToggle.remove();
      lookPill.remove();
      cardChrome.remove();
      lightChrome.remove();
      delete row.dataset.open;
      delete roots.stage.dataset.sheet;
      doc.body.removeAttribute('data-shell-sheet-open');
      roots.rail.hidden = false;
      roots.rail.inert = false;
      roots.rail.removeAttribute('aria-hidden');
      roots.card.hidden = false;
      roots.lightPanel.hidden = false;
    },
  };
}
