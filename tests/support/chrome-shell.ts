import { vi } from 'vitest';

// The shell is the page chrome; jsdom ships no matchMedia and no useful viewport dimensions, so
// both are stubbed: the stub answers width and short-viewport queries from the dimensions the test
// sets, and resizeTo fires the registered change listeners the same way the browser would.
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

export function stubViewport(width: number, height = 800): void {
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
export function resizeTo(width: number, height = 800): void {
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

export function buildDocument(): void {
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
