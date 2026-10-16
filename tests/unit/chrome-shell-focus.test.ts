// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountShell } from '../../src/ui/shell';
import type { ShellHandle } from '../../src/ui/shell';
import { buildDocument, resizeTo, stubViewport } from '../support/chrome-shell';

// The shell is the page chrome; these tests pin where focus goes: the invoker record on Escape
// and the controls inside the panels.

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
