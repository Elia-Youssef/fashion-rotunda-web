// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installTooltips } from '../../src/ui/tooltip';
import type { TooltipHandle } from '../../src/ui/tooltip';

let root: HTMLElement;
let handle: TooltipHandle | null = null;
let btn1: HTMLButtonElement;
let btn2: HTMLButtonElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);

  btn1 = document.createElement('button');
  btn1.type = 'button';
  btn1.dataset.tooltip = 'First tooltip';
  root.appendChild(btn1);

  btn2 = document.createElement('button');
  btn2.type = 'button';
  btn2.setAttribute('aria-describedby', 'existing-id');
  btn2.dataset.tooltip = 'Second tooltip';
  root.appendChild(btn2);
});

afterEach(() => {
  handle?.dispose();
  handle = null;
  root.remove();
});

describe('installTooltips', () => {
  it('creates one hidden tooltip element with role="tooltip"', () => {
    handle = installTooltips(root);
    const tooltip = root.querySelector('.a11y-tooltip');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.getAttribute('role')).toBe('tooltip');
    expect((tooltip as HTMLElement).hidden).toBe(true);
  });

  it('shows tooltip on pointerover and links with aria-describedby', () => {
    handle = installTooltips(root);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');

    btn1.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    expect(tooltip?.hidden).toBe(false);
    expect(tooltip?.textContent).toBe('First tooltip');
    expect(btn1.getAttribute('aria-describedby')).toBe('a11y-tooltip');

    btn1.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
    expect(tooltip?.hidden).toBe(true);
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
  });

  it('shows tooltip on focusin and hides on focusout', () => {
    handle = installTooltips(root);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');

    btn1.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(tooltip?.hidden).toBe(false);
    expect(tooltip?.textContent).toBe('First tooltip');
    expect(btn1.getAttribute('aria-describedby')).toBe('a11y-tooltip');

    btn1.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(tooltip?.hidden).toBe(true);
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
  });

  it('hides tooltip when Escape key is pressed', () => {
    handle = installTooltips(root);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');

    btn1.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(tooltip?.hidden).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(tooltip?.hidden).toBe(true);
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
  });

  it('preserves existing aria-describedby when showing and hiding', () => {
    handle = installTooltips(root);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');

    btn2.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(tooltip?.hidden).toBe(false);
    expect(btn2.getAttribute('aria-describedby')).toBe('existing-id a11y-tooltip');

    btn2.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(tooltip?.hidden).toBe(true);
    expect(btn2.getAttribute('aria-describedby')).toBe('existing-id');
  });

  it('showing twice on one anchor still restores the original describedby', () => {
    handle = installTooltips(root);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');

    // Hover then hover again, the sequence a pointer sends when it moves inside the control.
    btn2.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    btn2.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    expect(btn2.getAttribute('aria-describedby')).toBe('existing-id a11y-tooltip');

    btn2.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
    expect(tooltip?.hidden).toBe(true);
    expect(btn2.getAttribute('aria-describedby')).toBe('existing-id');

    // Same walk on an anchor that carried no description at all.
    btn1.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    btn1.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    btn1.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
  });

  it('dispose removes tooltip element and listeners', () => {
    handle = installTooltips(root);
    handle.dispose();
    handle = null;

    expect(root.querySelector('.a11y-tooltip')).toBeNull();
    btn1.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
  });
});
