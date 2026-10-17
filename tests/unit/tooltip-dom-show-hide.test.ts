// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTooltips } from '../../src/ui/tooltip';
import type { TooltipHandle } from '../../src/ui/tooltip';
import { answerFocusVisible, keyboardFocus, mountTooltipDom } from '../support/tooltip-dom';

// The tooltip on its anchors: creation, showing and hiding by pointer and keyboard focus, the
// aria-describedby bookkeeping around both, and dismissal and disposal.

let root: HTMLElement;
let handle: TooltipHandle | null = null;
let btn1: HTMLButtonElement;
let btn2: HTMLButtonElement;

beforeEach(() => {
  vi.useFakeTimers();
  ({ root, btn1, btn2 } = mountTooltipDom());
});

afterEach(() => {
  handle?.dispose();
  handle = null;
  root.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
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
    vi.runAllTimers();
    expect(tooltip?.hidden).toBe(true);
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
  });

  it('shows tooltip on keyboard-visible focus and hides on blur', () => {
    handle = installTooltips(root);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');

    keyboardFocus(btn1);
    expect(tooltip?.hidden).toBe(false);
    expect(tooltip?.textContent).toBe('First tooltip');
    expect(btn1.getAttribute('aria-describedby')).toBe('a11y-tooltip');

    btn1.blur();
    expect(tooltip?.hidden).toBe(true);
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
  });

  it('hides tooltip when Escape key is pressed', () => {
    handle = installTooltips(root);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');

    keyboardFocus(btn1);
    expect(tooltip?.hidden).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(tooltip?.hidden).toBe(true);
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
  });

  it('preserves existing aria-describedby when showing and hiding', () => {
    handle = installTooltips(root);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');

    keyboardFocus(btn2);
    expect(tooltip?.hidden).toBe(false);
    expect(btn2.getAttribute('aria-describedby')).toBe('existing-id a11y-tooltip');

    btn2.blur();
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
    vi.runAllTimers();
    expect(tooltip?.hidden).toBe(true);
    expect(btn2.getAttribute('aria-describedby')).toBe('existing-id');

    // Same walk on an anchor that carried no description at all.
    btn1.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    btn1.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    btn1.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
    vi.runAllTimers();
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
  });

  it('shows no tooltip for focus the browser draws no ring for, such as script focus after a click', () => {
    handle = installTooltips(root);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');
    // jsdom has no input modality, so it reports every focused element as :focus-visible. The
    // stub answers as a browser does after a mouse click moved focus into a panel.
    answerFocusVisible(btn1, () => false);

    btn1.focus();
    expect(document.activeElement).toBe(btn1);
    expect(tooltip?.hidden).toBe(true);
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);

    // Hover still shows it.
    btn1.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    expect(tooltip?.hidden).toBe(false);
    expect(tooltip?.textContent).toBe('First tooltip');
  });

  it('shows the focus tooltip when :focus-visible cannot be parsed', () => {
    handle = installTooltips(root);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');
    answerFocusVisible(btn1, () => {
      throw new SyntaxError('unsupported selector');
    });

    btn1.focus();
    expect(tooltip?.hidden).toBe(false);
  });

  it('shows no tooltip for blank text', () => {
    handle = installTooltips(root);
    btn1.dataset.tooltip = '   ';
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');

    btn1.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    expect(tooltip?.hidden).toBe(true);
    keyboardFocus(btn1);
    expect(tooltip?.hidden).toBe(true);
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
  });

  it('ignores pointer and focus events that carry no anchor, without throwing', () => {
    handle = installTooltips(root);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');
    const plain = document.createElement('span');
    root.appendChild(plain);

    plain.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: root }));
    plain.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: root }));
    plain.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: btn1 }));
    expect(tooltip?.hidden).toBe(true);
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
    expect(btn2.getAttribute('aria-describedby')).toBe('existing-id');
  });

  it('describes an anchor that already lists the tooltip id exactly once', () => {
    handle = installTooltips(root);
    btn1.setAttribute('aria-describedby', 'a11y-tooltip other-id');

    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');

    keyboardFocus(btn1);
    expect(btn1.getAttribute('aria-describedby')).toBe('a11y-tooltip other-id');
    expect(tooltip?.textContent).toBe('First tooltip');
    btn1.blur();
    expect(btn1.getAttribute('aria-describedby')).toBe('a11y-tooltip other-id');
    // The anchor keeps its reference to the hidden tooltip, and a description is computed from a
    // directly referenced hidden element, so hiding must leave no stale text behind.
    expect(tooltip?.textContent).toBe('');
  });

  it('keeps the tooltip when the pointer crosses to a child of the anchor', () => {
    handle = installTooltips(root);
    const child = document.createElement('span');
    btn1.appendChild(child);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');

    btn1.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    btn1.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: child }));
    vi.runAllTimers();
    expect(tooltip?.hidden).toBe(false);
    expect(tooltip?.textContent).toBe('First tooltip');
  });

  it('keeps the tooltip when focus moves to a child of the anchor', () => {
    handle = installTooltips(root);
    const child = document.createElement('span');
    btn1.appendChild(child);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');

    keyboardFocus(btn1);
    btn1.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: child }));
    expect(tooltip?.hidden).toBe(false);
  });

  it('does not start the leave delay for a pointerout from an unrelated control', () => {
    handle = installTooltips(root);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');

    btn1.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    btn2.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: root }));
    vi.runAllTimers();
    expect(tooltip?.hidden).toBe(false);
  });

  it('shows the tooltip again on focus after Escape dismissed it under the pointer', () => {
    handle = installTooltips(root);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');

    btn1.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(tooltip?.hidden).toBe(true);

    keyboardFocus(btn1);
    expect(tooltip?.hidden).toBe(false);
    expect(btn1.getAttribute('aria-describedby')).toBe('a11y-tooltip');
  });

  it('leaves PageDown to the browser when the shown tooltip cannot scroll', () => {
    handle = installTooltips(root);
    keyboardFocus(btn1);

    const page = new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true });
    btn1.dispatchEvent(page);
    expect(page.defaultPrevented).toBe(false);
  });

  it('returns to the hovered trigger when a different focused trigger blurs', () => {
    handle = installTooltips(root);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');

    btn1.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    keyboardFocus(btn2);
    expect(tooltip?.textContent).toBe('Second tooltip');

    btn2.blur();
    vi.runAllTimers();
    expect(tooltip?.hidden).toBe(false);
    expect(tooltip?.textContent).toBe('First tooltip');
    expect(btn1.getAttribute('aria-describedby')).toBe('a11y-tooltip');
    expect(btn2.getAttribute('aria-describedby')).toBe('existing-id');
  });

  it('dispose removes tooltip element and listeners', () => {
    handle = installTooltips(root);
    handle.dispose();
    handle = null;

    expect(root.querySelector('.a11y-tooltip')).toBeNull();
    btn1.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    btn1.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
  });

  it('retires a leave delay that outlives an Escape-hidden tooltip on disposal', () => {
    handle = installTooltips(root);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip');
    btn1.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(tooltip?.hidden).toBe(true);

    // Escape hid the box but the pointer is still on the control, so a leave
    // delay can be pending with nothing shown; disposal must cancel it.
    btn1.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: root }));
    expect(vi.getTimerCount()).toBe(1);
    handle!.dispose();
    handle = null;
    expect(vi.getTimerCount()).toBe(0);
  });
});
