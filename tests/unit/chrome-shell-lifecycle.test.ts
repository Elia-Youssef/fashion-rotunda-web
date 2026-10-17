// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountShell } from '../../src/ui/shell';
import type { ShellHandle } from '../../src/ui/shell';
import { buildDocument, resizeTo, stubViewport } from '../support/chrome-shell';

// The shell is the page chrome; these tests pin mounting it onto the document and tearing it down.

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
    expect(document.querySelectorAll('.shell-sheet__content')).toHaveLength(0);
    expect(document.getElementById('shell-light-panel')?.parentElement?.id).toBe('shell-light-row');
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
