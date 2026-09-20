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
const registered: Array<{ fire: () => void }> = [];

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

/** The browser half of a resize: new dimensions, then the change events the queries owe. */
function resizeTo(width: number, height = 800): void {
  stubWidth = width;
  stubHeight = height;
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
  for (const entry of registered) {
    entry.fire();
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
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    expect(button?.textContent).toBe('Light Control');
  });

  it('throws when index.html is missing a root', () => {
    stubViewport(1440);
    document.getElementById('shell-stage')?.remove();
    expect(() => mountShell(document)).toThrow('canvas stage');
  });
});

describe('the light panel disclosure', () => {
  it('starts open above the phone width and hides the panel when closed', () => {
    stubViewport(1200);
    shell = mountShell(document);
    const panel = document.getElementById('shell-light-panel');
    const button = document.getElementById('shell-light-toggle');
    expect(shell.lightPanelOpen).toBe(true);
    expect(panel?.hidden).toBe(false);
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

  it('returns the breakpoints to their defaults on a change', () => {
    stubViewport(390);
    shell = mountShell(document);
    shell.setCardOpen(true);
    resizeTo(1300);
    expect(shell.breakpoint).toBe('desktop');
    expect(shell.lightPanelOpen).toBe(true);
    expect(shell.cardOpen).toBe(true);
    expect(document.getElementById('shell-card')?.hidden).toBe(false);
  });

  it('returns a short tablet to columns when its height grows', () => {
    stubViewport(844, 390);
    shell = mountShell(document);
    expect(shell.cardOpen).toBe(false);
    expect(shell.lightPanelOpen).toBe(false);
    resizeTo(844, 900);
    expect(shell.breakpoint).toBe('tablet');
    expect(shell.cardOpen).toBe(true);
    expect(shell.lightPanelOpen).toBe(true);
    expect(document.getElementById('shell-card')?.hidden).toBe(false);
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
    expect(document.getElementById('shell-light-row')?.dataset.open).toBeUndefined();
    expect(document.getElementById('shell-stage')?.dataset.sheet).toBeUndefined();
  });
});
