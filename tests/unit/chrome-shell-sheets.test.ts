// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountShell } from '../../src/ui/shell';
import type { ShellHandle } from '../../src/ui/shell';
import { buildDocument, stubViewport } from '../support/chrome-shell';

// The shell is the page chrome; these tests pin the phone and short-viewport sheets: opening,
// closing, exclusivity and the close controls.

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
