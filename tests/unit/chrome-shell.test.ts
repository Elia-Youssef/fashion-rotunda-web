// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BREAKPOINTS, breakpointFor, mountShell } from '../../src/ui/shell';
import type { ShellHandle } from '../../src/ui/shell';

// The shell is the page chrome, so its test file sits in the chrome-*.test.ts family the UI code
// owns. jsdom ships no matchMedia and no useful viewport dimensions, so both are stubbed: the
// stub answers width and short-viewport queries from the dimensions the test sets, and resizeTo
// fires the registered change listeners the same way the browser would.

let stubWidth = 0;
let stubHeight = 0;
const registered: Array<{ query: string; matches: boolean; fire: () => void }> = [];

function queryMatches(query: string): boolean {
  const minWidth = /min-width:\s*(\d+)px/.exec(query);
  const maxHeight = /max-height:\s*(\d+)px/.exec(query);
  return (
    (minWidth === null || stubWidth >= Number(minWidth[1])) &&
    (maxHeight === null || stubHeight <= Number(maxHeight[1]))
  );
}

function stubViewport(width: number, height = 800): void {
  stubWidth = width;
  stubHeight = height;
  registered.length = 0;
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    const listeners = new Set<(event: Event) => void>();
    registered.push({
      query,
      matches: queryMatches(query),
      fire(): void {
        const event = new Event('change');
        for (const listener of listeners) {
          listener(event);
        }
      },
    });
    // jsdom ships no matchMedia, so this object is the whole browser feature as far as the test
    // is concerned; the assertion only bridges the overloads the interface declares and the
    // three members the shell actually reads (matches, addEventListener, removeEventListener).
    return {
      matches: queryMatches(query),
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: (event: Event) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: Event) => void) => {
        listeners.delete(listener);
      },
      addListener: (listener: (event: Event) => void) => {
        listeners.add(listener);
      },
      removeListener: (listener: (event: Event) => void) => {
        listeners.delete(listener);
      },
      dispatchEvent: () => false,
    } as MediaQueryList;
  });
}

/** The browser half of a resize: new dimensions, then a change event for each query whose match
 * state flipped, which is when a real MediaQueryList fires its change listeners. */
function resizeTo(width: number, height = 800): void {
  stubWidth = width;
  stubHeight = height;
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  for (const entry of registered) {
    const now = queryMatches(entry.query);
    if (now !== entry.matches) {
      entry.matches = now;
      entry.fire();
    }
  }
}

function buildDocument(): void {
  document.body.innerHTML = `
    <header id="shell-header"><h1>Fashion Rotunda, web edition</h1></header>
    <main>
      <nav id="looks"></nav>
      <div id="shell-stage">
        <canvas id="scene"></canvas>
        <aside id="shell-card"></aside>
        <div id="shell-light-row"><div id="shell-light-panel"></div></div>
      </div>
    </main>
    <footer><aside id="shell-proof"></aside></footer>
  `;
}

let shell: ShellHandle | null = null;

beforeEach(() => {
  buildDocument();
});

afterEach(() => {
  shell?.dispose();
  shell = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('breakpointFor', () => {
  it('names the same thresholds the CSS media queries use', () => {
    expect(BREAKPOINTS.phone.min).toBe(0);
    expect(BREAKPOINTS.tablet.min).toBe(768);
    expect(BREAKPOINTS.desktop.min).toBe(1200);
  });

  it.each([
    [0, 'phone'],
    [320, 'phone'],
    [767, 'phone'],
    [768, 'tablet'],
    [1199, 'tablet'],
    [1200, 'desktop'],
    [1440, 'desktop'],
  ] as const)('reads %i as %s', (width, expected) => {
    expect(breakpointFor(width)).toBe(expected);
  });
});

describe('mountShell', () => {
  it('finds the six roots by their ids', () => {
    stubViewport(1440);
    shell = mountShell(document);
    expect(shell.roots.header.id).toBe('shell-header');
    expect(shell.roots.rail.id).toBe('looks');
    expect(shell.roots.stage.id).toBe('shell-stage');
    expect(shell.roots.card.tagName).toBe('ASIDE');
    expect(shell.roots.card.id).toBe('shell-card');
    expect(shell.roots.lightPanel.id).toBe('shell-light-panel');
    expect(shell.roots.proof.id).toBe('shell-proof');
  });

  it('mounts one disclosure button wired to the panel root', () => {
    stubViewport(1440);
    shell = mountShell(document);
    const button = document.getElementById('shell-light-toggle');
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.getAttribute('aria-controls')).toBe('shell-light-panel');
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(button?.textContent).toBe('Light Control');
  });

  it('throws when index.html is missing a root', () => {
    stubViewport(1440);
    document.getElementById('shell-stage')?.remove();
    expect(() => mountShell(document)).toThrow('canvas stage');
  });

  it('throws when the light panel row is not an HTML element', () => {
    stubViewport(1440);
    // An SVG parent is an Element but not an HTMLElement, so the shell must refuse it.
    document.getElementById('shell-light-row')?.remove();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const panel = document.createElement('div');
    panel.id = 'shell-light-panel';
    svg.appendChild(panel);
    document.getElementById('shell-stage')?.appendChild(svg);
    expect(() => mountShell(document)).toThrow('light row');
  });

  it('mounts a detached document as phone sheets without throwing', () => {
    // A document with no default view has no width and no matchMedia; width 0 is a phone.
    const doc = document.implementation.createHTMLDocument('detached');
    doc.body.innerHTML = document.body.innerHTML;
    expect(doc.defaultView).toBeNull();
    const detached = mountShell(doc);
    expect(detached.breakpoint).toBe('phone');
    expect(doc.getElementById('shell-card')?.hidden).toBe(true);
    detached.dispose();
  });

  it('stays at the width it mounted with when the view has no matchMedia', () => {
    // jsdom ships no matchMedia, so the shell keeps its mount-time breakpoint and layout.
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    shell = mountShell(document);
    expect(shell.breakpoint).toBe('tablet');
    expect(document.querySelector<HTMLElement>('.shell-pill--look')?.hidden).toBe(true);
    Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true });
    expect(shell.breakpoint).toBe('tablet');
  });
});

describe('the short-viewport boundary', () => {
  it.each([
    [599, true],
    [600, false],
  ])('treats a %ipx-tall tablet by the 599px rule', (height, short) => {
    stubViewport(844, height);
    shell = mountShell(document);
    expect(shell.breakpoint).toBe('tablet');
    expect(shell.cardOpen).toBe(!short);
    expect(document.getElementById('shell-card')?.hidden).toBe(short);
  });

  it('enters sheet country exactly at 599px of height', () => {
    stubViewport(844, 600);
    shell = mountShell(document);
    expect(document.getElementById('shell-card')?.hidden).toBe(false);
    resizeTo(844, 599);
    expect(shell.breakpoint).toBe('tablet');
    expect(shell.cardOpen).toBe(false);
    expect(document.getElementById('shell-card')?.hidden).toBe(true);
  });
});

describe('the width boundaries the resize queries watch', () => {
  it('notifies tablet exactly at 768px and desktop exactly at 1200px', () => {
    stubViewport(390);
    shell = mountShell(document);
    const seen: string[] = [];
    shell.onBreakpointChange((bp) => seen.push(bp));
    resizeTo(768);
    expect(seen).toEqual(['tablet']);
    resizeTo(1200);
    expect(seen).toEqual(['tablet', 'desktop']);
  });
});

describe('the light panel disclosure', () => {
  it('starts closed at every review viewport, ARIA and hidden in agreement', () => {
    const reviewViewports: Array<[number, number]> = [
      [1440, 900],
      [820, 1180],
      [390, 844],
      [844, 390],
    ];
    for (const [width, height] of reviewViewports) {
      stubViewport(width, height);
      shell = mountShell(document);
      const panel = document.getElementById('shell-light-panel');
      const button = document.getElementById('shell-light-toggle');
      expect(shell.lightPanelOpen, `${width}x${height}: the panel starts closed`).toBe(false);
      expect(panel?.hidden, `${width}x${height}: the panel root is hidden`).toBe(true);
      expect(
        button?.getAttribute('aria-expanded'),
        `${width}x${height}: the toggle agrees it is closed`,
      ).toBe('false');
      shell?.dispose();
      shell = null;
    }
  });

  it('opens on the button above the phone width and hides the panel when closed again', () => {
    stubViewport(1200);
    shell = mountShell(document);
    const panel = document.getElementById('shell-light-panel');
    const button = document.getElementById('shell-light-toggle');
    expect(shell.lightPanelOpen).toBe(false);
    expect(panel?.hidden).toBe(true);
    button?.click();
    expect(shell.lightPanelOpen).toBe(true);
    expect(panel?.hidden).toBe(false);
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    shell.setLightPanelOpen(false);
    expect(panel?.hidden).toBe(true);
    expect(button?.getAttribute('aria-expanded')).toBe('false');
    expect(shell.lightPanelOpen).toBe(false);
  });

  it('starts closed on the phone and opens on the button', () => {
    stubViewport(390);
    shell = mountShell(document);
    const panel = document.getElementById('shell-light-panel');
    expect(shell.breakpoint).toBe('phone');
    expect(shell.lightPanelOpen).toBe(false);
    expect(panel?.hidden).toBe(true);
    document.getElementById('shell-light-toggle')?.click();
    expect(panel?.hidden).toBe(false);
    expect(shell.lightPanelOpen).toBe(true);
  });

  it('uses a closed light sheet on a short landscape tablet', () => {
    stubViewport(844, 390);
    shell = mountShell(document);
    const panel = document.getElementById('shell-light-panel');
    expect(shell.breakpoint).toBe('tablet');
    expect(shell.lightPanelOpen).toBe(false);
    expect(panel?.hidden).toBe(true);
  });

  it('marks the row open so the sheet styling applies', () => {
    stubViewport(390);
    shell = mountShell(document);
    const row = document.getElementById('shell-light-row');
    expect(row?.dataset.open).toBe('false');
    shell.setLightPanelOpen(true);
    expect(row?.dataset.open).toBe('true');
  });

  it.each([
    [390, 844],
    [844, 390],
  ])('keeps the closed light-sheet close control inert at %ix%i', (width, height) => {
    stubViewport(width, height);
    shell = mountShell(document);
    const chrome = document.querySelector<HTMLElement>('#shell-light-row .shell-sheet__chrome');
    const close = chrome?.querySelector<HTMLButtonElement>('.shell-sheet__close');

    expect(chrome?.hidden).toBe(true);
    expect(chrome?.inert).toBe(true);
    expect(chrome?.getAttribute('aria-hidden')).toBe('true');
    expect(close?.tabIndex).toBe(-1);

    shell.setLightPanelOpen(true);
    expect(chrome?.hidden).toBe(false);
    expect(chrome?.inert).toBe(false);
    expect(chrome?.getAttribute('aria-hidden')).toBe('false');
    expect(close?.tabIndex).toBe(0);
  });

  it.each([
    [390, 844],
    [844, 390],
    [1440, 900],
  ])('dismisses the light disclosure with Escape and returns focus at %ix%i', (width, height) => {
    stubViewport(width, height);
    shell = mountShell(document);
    const toggle = document.getElementById('shell-light-toggle') as HTMLButtonElement;
    toggle.focus();
    toggle.click();
    expect(shell.lightPanelOpen).toBe(true);

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(true);
    expect(shell.lightPanelOpen).toBe(false);
    expect(document.getElementById('shell-light-panel')?.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });
});

describe('the card sheet', () => {
  it('is a no-op that reports true above the phone width', () => {
    stubViewport(820);
    shell = mountShell(document);
    const card = document.getElementById('shell-card');
    expect(shell.cardOpen).toBe(true);
    shell.setCardOpen(false);
    expect(shell.cardOpen).toBe(true);
    expect(card?.hidden).toBe(false);
  });

  it('opens and closes on the phone, one sheet at a time', () => {
    stubViewport(390);
    shell = mountShell(document);
    const card = document.getElementById('shell-card');
    const stage = document.getElementById('shell-stage');
    expect(card?.hidden).toBe(true);
    expect(shell.cardOpen).toBe(false);

    shell.setCardOpen(true);
    expect(card?.hidden).toBe(false);
    expect(shell.cardOpen).toBe(true);
    expect(stage?.dataset.sheet).toBe('true');
    expect(shell.lightPanelOpen).toBe(false);

    shell.setLightPanelOpen(true);
    expect(card?.hidden).toBe(true);
    expect(shell.cardOpen).toBe(false);
    expect(shell.lightPanelOpen).toBe(true);
  });

  it('hides and inerts the background rail while either phone sheet is open', () => {
    stubViewport(390);
    const cardControl = document.createElement('button');
    cardControl.className = 'product-card__action';
    document.getElementById('shell-card')?.appendChild(cardControl);
    shell = mountShell(document);
    const rail = document.getElementById('looks');

    expect(rail?.hidden).toBe(false);
    expect(rail?.inert).toBe(false);
    expect(rail?.getAttribute('aria-hidden')).toBe('false');

    shell.setLightPanelOpen(true);
    expect(rail?.hidden).toBe(true);
    expect(rail?.inert).toBe(true);
    expect(rail?.getAttribute('aria-hidden')).toBe('true');
    shell.setLightPanelOpen(false);
    expect(rail?.hidden).toBe(false);
    expect(rail?.inert).toBe(false);
    expect(rail?.getAttribute('aria-hidden')).toBe('false');

    shell.setCardOpen(true);
    expect(document.activeElement).toBe(
      document.querySelector('#shell-card .shell-sheet__close'),
    );
    expect(rail?.hidden).toBe(true);
    expect(rail?.inert).toBe(true);
    shell.setCardOpen(false);
    expect(rail?.hidden).toBe(false);
    expect(rail?.inert).toBe(false);
  });

  it('opens and closes the card sheet on a short landscape tablet', () => {
    stubViewport(844, 390);
    shell = mountShell(document);
    const card = document.getElementById('shell-card');
    shell.setCardOpen(true);
    expect(card?.hidden).toBe(false);
    expect(shell.cardOpen).toBe(true);
    expect(shell.lightPanelOpen).toBe(false);
    shell.setCardOpen(false);
    expect(card?.hidden).toBe(true);
  });

  it('closes from its close button', () => {
    stubViewport(390);
    shell = mountShell(document);
    shell.setCardOpen(true);
    const close = document.querySelector<HTMLElement>('#shell-card .shell-sheet__close');
    close?.click();
    expect(shell.cardOpen).toBe(false);
    expect(document.getElementById('shell-card')?.hidden).toBe(true);
  });

  it('closes the light sheet from its close button', () => {
    stubViewport(390);
    shell = mountShell(document);
    shell.setLightPanelOpen(true);
    const close = document.querySelector<HTMLElement>('#shell-light-row .shell-sheet__close');
    close?.click();
    expect(shell.lightPanelOpen).toBe(false);
    expect(document.getElementById('shell-light-panel')?.hidden).toBe(true);
  });

  it.each([
    [390, 844],
    [844, 390],
  ])('dismisses the card sheet with Escape and returns focus at %ix%i', (width, height) => {
    stubViewport(width, height);
    shell = mountShell(document);
    const trigger = document.querySelector<HTMLButtonElement>('.shell-pill--look');
    trigger?.focus();
    trigger?.click();
    expect(shell.cardOpen).toBe(true);

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(true);
    expect(shell.cardOpen).toBe(false);
    expect(document.getElementById('shell-card')?.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });
});

describe('the sheet close buttons', () => {
  it('focuses card content when its close button has been removed', () => {
    stubViewport(390);
    shell = mountShell(document);
    const control = document.createElement('button');
    shell.roots.card.append(control);
    shell.roots.card.querySelector<HTMLButtonElement>('.shell-sheet__close')!.remove();
    shell.setCardOpen(true);
    expect(document.activeElement).toBe(control);
  });

  // WCAG 2.5.3 (label in name): the accessible name must contain the visible label text. The
  // chrome paints the glyph "x" as real text, which the name "Close" cannot contain, so the
  // factory hides the glyph inside an aria-hidden span. jsdom computes no accessible name, so
  // the test reads the attribute the name comes from and walks each button for text outside an
  // aria-hidden element; the browser specs pin the computed name through getByRole.
  function textOutsideAriaHidden(element: Element): string[] {
    const found: string[] = [];
    const walk = (node: Node, hidden: boolean): void => {
      if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') {
        hidden = true;
      }
      if (node.nodeType === Node.TEXT_NODE && !hidden && (node.textContent ?? '').trim() !== '') {
        found.push((node.textContent ?? '').trim());
      }
      for (const child of Array.from(node.childNodes)) {
        walk(child, hidden);
      }
    };
    walk(element, false);
    return found;
  }

  it('names both close buttons Close with no visible text outside aria-hidden', () => {
    stubViewport(390);
    shell = mountShell(document);

    shell.setCardOpen(true);
    const cardClose = document.querySelector('#shell-card .shell-sheet__close');
    expect(cardClose, 'the card sheet mounts a close button').not.toBeNull();
    expect(cardClose?.getAttribute('aria-label'), 'the card close is named Close').toBe('Close');
    expect(
      textOutsideAriaHidden(cardClose as HTMLElement),
      'the card close shows no text outside an aria-hidden element',
    ).toEqual([]);

    shell.setCardOpen(false);
    shell.setLightPanelOpen(true);
    const lightClose = document.querySelector('#shell-light-row .shell-sheet__close');
    expect(lightClose, 'the light sheet mounts a close button').not.toBeNull();
    expect(lightClose?.getAttribute('aria-label'), 'the light close is named Close').toBe('Close');
    expect(
      textOutsideAriaHidden(lightClose as HTMLElement),
      'the light close shows no text outside an aria-hidden element',
    ).toEqual([]);
  });
});

describe('onBreakpointChange', () => {
  it('notifies on a real change and not on a resize inside the same breakpoint', () => {
    stubViewport(390);
    shell = mountShell(document);
    const seen: string[] = [];
    shell.onBreakpointChange((bp) => seen.push(bp));
    resizeTo(500);
    expect(seen).toEqual([]);
    resizeTo(900);
    expect(seen).toEqual(['tablet']);
    resizeTo(1300);
    expect(seen).toEqual(['tablet', 'desktop']);
  });

  it('returns an unsubscribe that stops the listener', () => {
    stubViewport(390);
    shell = mountShell(document);
    const seen: string[] = [];
    const stop = shell.onBreakpointChange((bp) => seen.push(bp));
    stop();
    resizeTo(1300);
    expect(seen).toEqual([]);
  });

  it('returns the breakpoints to their closed defaults on a change', () => {
    stubViewport(390);
    shell = mountShell(document);
    shell.setCardOpen(true);
    resizeTo(1300);
    expect(shell.breakpoint).toBe('desktop');
    expect(shell.lightPanelOpen).toBe(false);
    expect(shell.cardOpen).toBe(true);
    expect(document.getElementById('shell-card')?.hidden).toBe(false);
  });

  it('returns a short tablet to columns closed when its height grows', () => {
    stubViewport(844, 390);
    shell = mountShell(document);
    expect(shell.cardOpen).toBe(false);
    expect(shell.lightPanelOpen).toBe(false);
    resizeTo(844, 900);
    expect(shell.breakpoint).toBe('tablet');
    expect(shell.cardOpen).toBe(true);
    expect(shell.lightPanelOpen).toBe(false);
    expect(document.getElementById('shell-card')?.hidden).toBe(false);
  });

  it('returns focus to Light Control when a responsive transition hides the open panel', () => {
    stubViewport(844, 900);
    const control = document.createElement('button');
    document.getElementById('shell-light-panel')?.appendChild(control);
    shell = mountShell(document);
    shell.setLightPanelOpen(true);
    control.focus();

    resizeTo(844, 390);

    expect(document.getElementById('shell-light-panel')?.hidden).toBe(true);
    expect(document.activeElement).toBe(document.getElementById('shell-light-toggle'));
  });

  it('returns focus to Look when entering sheet mode hides the desktop card', () => {
    stubViewport(1440, 900);
    const control = document.createElement('button');
    document.getElementById('shell-card')?.appendChild(control);
    shell = mountShell(document);
    control.focus();

    resizeTo(390, 844);

    expect(document.getElementById('shell-card')?.hidden).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('.shell-pill--look'));
  });

  it('moves focus off sheet-only Close controls when leaving sheet mode', () => {
    stubViewport(390, 844);
    const cardControl = document.createElement('button');
    cardControl.className = 'product-card__action';
    document.getElementById('shell-card')?.appendChild(cardControl);
    shell = mountShell(document);

    shell.setLightPanelOpen(true);
    const lightClose = document.querySelector<HTMLButtonElement>(
      '#shell-light-row .shell-sheet__close',
    );
    lightClose?.focus();
    resizeTo(1440, 900);
    expect(document.activeElement).toBe(document.getElementById('shell-light-toggle'));

    resizeTo(390, 844);
    shell.setCardOpen(true);
    const cardClose = document.querySelector<HTMLButtonElement>('#shell-card .shell-sheet__close');
    cardClose?.focus();
    resizeTo(1440, 900);
    expect(document.activeElement).toBe(cardControl);
  });

  it('moves focus from the phone Look pill to a visible card control on desktop', () => {
    stubViewport(390, 844);
    const cardControl = document.createElement('button');
    cardControl.className = 'product-card__action';
    document.getElementById('shell-card')?.appendChild(cardControl);
    shell = mountShell(document);
    const lookPill = document.querySelector<HTMLButtonElement>('.shell-pill--look');
    lookPill?.focus();

    resizeTo(1440, 900);

    expect(lookPill?.hidden).toBe(true);
    expect(document.activeElement).toBe(cardControl);
  });
});

describe('dispose', () => {
  it('removes the shell furniture and un-hides the roots', () => {
    stubViewport(390);
    shell = mountShell(document);
    shell.setLightPanelOpen(true);
    shell.dispose();
    shell = null;
    expect(document.getElementById('shell-light-toggle')).toBeNull();
    expect(document.querySelector('.shell-pill--look')).toBeNull();
    expect(document.querySelectorAll('.shell-sheet__chrome')).toHaveLength(0);
    expect(document.getElementById('shell-card')?.hidden).toBe(false);
    expect(document.getElementById('shell-light-panel')?.hidden).toBe(false);
    expect(document.getElementById('looks')?.hidden).toBe(false);
    expect(document.getElementById('looks')?.inert).toBe(false);
    expect(document.getElementById('looks')?.hasAttribute('aria-hidden')).toBe(false);
    expect(document.getElementById('shell-light-row')?.dataset.open).toBeUndefined();
    expect(document.getElementById('shell-stage')?.dataset.sheet).toBeUndefined();
    expect(document.body.hasAttribute('data-shell-sheet-open')).toBe(false);
  });

  it('stops responding to resizes after dispose', () => {
    stubViewport(390);
    const disposed = mountShell(document);
    const seen: string[] = [];
    disposed.onBreakpointChange((bp) => seen.push(bp));
    disposed.dispose();
    resizeTo(1300);
    expect(seen).toEqual([]);
    // The shell is frozen at its dispose-time state, and its DOM markers stay cleaned up.
    expect(disposed.breakpoint).toBe('phone');
    expect(document.getElementById('shell-light-row')?.dataset.open).toBeUndefined();
    expect(document.getElementById('looks')?.hidden).toBe(false);
  });
});

describe('focus return and the invoker record', () => {
  // The invoker parameter is real on the shell's own click wiring but is not on the public
  // handle type, so these tests reach the same closure signature through a typed view.
  type InvokerHandle = {
    setLightPanelOpen(open: boolean, invoker?: HTMLElement): void;
    setCardOpen(open: boolean, invoker?: HTMLElement): void;
  };

  function invokerView(handle: ShellHandle): InvokerHandle {
    return handle as unknown as InvokerHandle;
  }

  it('returns focus to a custom light invoker on Escape', () => {
    stubViewport(390);
    shell = mountShell(document);
    const custom = document.createElement('button');
    document.getElementById('shell-stage')?.appendChild(custom);
    invokerView(shell).setLightPanelOpen(true, custom);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(shell.lightPanelOpen).toBe(false);
    expect(document.activeElement).toBe(custom);
  });

  it('returns focus to a custom card invoker on Escape', () => {
    stubViewport(390);
    shell = mountShell(document);
    const cardControl = document.createElement('button');
    document.getElementById('shell-card')?.appendChild(cardControl);
    const custom = document.createElement('button');
    document.getElementById('shell-stage')?.appendChild(custom);
    invokerView(shell).setCardOpen(true, custom);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(shell.cardOpen).toBe(false);
    expect(document.activeElement).toBe(custom);
  });

  it('does not return focus into the light panel it just hid', () => {
    stubViewport(390);
    const inPanel = document.createElement('button');
    document.getElementById('shell-light-panel')?.appendChild(inPanel);
    shell = mountShell(document);
    invokerView(shell).setLightPanelOpen(true, inPanel);
    expect(document.activeElement).toBe(inPanel);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(shell.lightPanelOpen).toBe(false);
    expect(document.activeElement).toBe(document.getElementById('shell-light-toggle'));
  });

  it('does not return focus to an invoker that left the document', () => {
    stubViewport(390);
    shell = mountShell(document);
    const visitor = document.createElement('button');
    document.getElementById('shell-stage')?.appendChild(visitor);
    invokerView(shell).setLightPanelOpen(true, visitor);
    visitor.remove();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(shell.lightPanelOpen).toBe(false);
    expect(document.activeElement).toBe(document.getElementById('shell-light-toggle'));
  });

  it('a reopen of an open light panel moves no focus and keeps the first invoker', () => {
    stubViewport(390);
    const control = document.createElement('button');
    document.getElementById('shell-light-panel')?.appendChild(control);
    shell = mountShell(document);
    const toggle = document.getElementById('shell-light-toggle') as HTMLButtonElement;
    const first = document.createElement('button');
    document.getElementById('shell-stage')?.appendChild(first);
    invokerView(shell).setLightPanelOpen(true, first);
    expect(document.activeElement).toBe(control);
    toggle.focus();
    const second = document.createElement('button');
    document.getElementById('shell-stage')?.appendChild(second);
    invokerView(shell).setLightPanelOpen(true, second);
    expect(document.activeElement).toBe(toggle);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(document.activeElement).toBe(first);
  });

  it('a reopen of an open card sheet moves no focus and keeps the first invoker', () => {
    stubViewport(390);
    const cardControl = document.createElement('button');
    document.getElementById('shell-card')?.appendChild(cardControl);
    shell = mountShell(document);
    const first = document.createElement('button');
    document.getElementById('shell-stage')?.appendChild(first);
    invokerView(shell).setCardOpen(true, first);
    cardControl.focus();
    const second = document.createElement('button');
    document.getElementById('shell-stage')?.appendChild(second);
    invokerView(shell).setCardOpen(true, second);
    expect(document.activeElement).toBe(cardControl);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(escape);
    expect(shell.cardOpen).toBe(false);
    expect(document.activeElement).toBe(first);
  });
});

describe('the controls inside the panels', () => {
  it('opens the light panel without focusing a hidden control', () => {
    stubViewport(390);
    const hidden = document.createElement('button');
    hidden.hidden = true;
    document.getElementById('shell-light-panel')?.appendChild(hidden);
    shell = mountShell(document);
    const before = document.activeElement;
    shell.setLightPanelOpen(true);
    expect(shell.lightPanelOpen).toBe(true);
    expect(document.activeElement).toBe(before);
  });

  it('focuses the Light Control toggle when the card has no visible control', () => {
    stubViewport(390);
    const hidden = document.createElement('button');
    hidden.hidden = true;
    document.getElementById('shell-card')?.appendChild(hidden);
    shell = mountShell(document);
    const lookPill = document.querySelector<HTMLButtonElement>('.shell-pill--look');
    lookPill?.focus();
    resizeTo(1440, 900);
    expect(document.activeElement).toBe(document.getElementById('shell-light-toggle'));
  });

  it('keeps the closed card sheet close control inert on the phone', () => {
    stubViewport(390);
    shell = mountShell(document);
    const chrome = document.querySelector<HTMLElement>('#shell-card .shell-sheet__chrome');
    const close = chrome?.querySelector<HTMLButtonElement>('.shell-sheet__close');
    expect(chrome?.hidden).toBe(true);
    expect(chrome?.inert).toBe(true);
    expect(chrome?.getAttribute('aria-hidden')).toBe('true');
    expect(close?.tabIndex).toBe(-1);
    shell.setCardOpen(true);
    expect(chrome?.hidden).toBe(false);
    expect(chrome?.inert).toBe(false);
    expect(close?.tabIndex).toBe(0);
  });

  it('expands the Look pill only while the card sheet is open', () => {
    stubViewport(390);
    shell = mountShell(document);
    const pill = document.querySelector('.shell-pill--look');
    expect(pill?.getAttribute('aria-expanded')).toBe('false');
    shell.setCardOpen(true);
    expect(pill?.getAttribute('aria-expanded')).toBe('true');
    shell.setCardOpen(false);
    expect(pill?.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('sheet exclusivity and idle close presses', () => {
  it('opening the card closes an open light panel on the phone', () => {
    stubViewport(390);
    shell = mountShell(document);
    shell.setLightPanelOpen(true);
    expect(shell.lightPanelOpen).toBe(true);
    shell.setCardOpen(true);
    expect(shell.cardOpen).toBe(true);
    expect(shell.lightPanelOpen).toBe(false);
  });

  it('a close press while both sheets are closed moves no focus', () => {
    stubViewport(390);
    shell = mountShell(document);
    document
      .querySelector<HTMLElement>('#shell-light-row .shell-sheet__close')
      ?.click();
    document.querySelector<HTMLElement>('#shell-card .shell-sheet__close')?.click();
    expect(shell.lightPanelOpen).toBe(false);
    expect(shell.cardOpen).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});
