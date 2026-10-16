// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BREAKPOINTS, breakpointFor, mountShell } from '../../src/ui/shell';
import type { ShellHandle } from '../../src/ui/shell';
import { buildDocument, resizeTo, stubViewport } from '../support/chrome-shell';

// The shell is the page chrome; these tests pin which breakpoint a viewport maps to and what a
// breakpoint change notifies and restores.

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
