// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTooltips } from '../../src/ui/tooltip';
import type { TooltipHandle } from '../../src/ui/tooltip';

let root: HTMLElement;
let handle: TooltipHandle | null = null;
let btn1: HTMLButtonElement;
let btn2: HTMLButtonElement;
// A short pointer journey is inside the production grace period, without tying the test to its exact value.
const SHORT_TRANSIT_MS = 50;

beforeEach(() => {
  vi.useFakeTimers();
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/**
 * Focus as a keyboard user gives it. jsdom's :focus-visible answer depends on its own input
 * heuristics across tests, so the element states the browser's answer for keyboard focus.
 */
function keyboardFocus(element: HTMLElement): void {
  answerFocusVisible(element, () => true);
  element.focus();
}

/** Replaces the element's answer to `:focus-visible`; every other selector matches as usual. */
function answerFocusVisible(element: HTMLElement, answer: () => boolean): void {
  const matches = element.matches.bind(element);
  Object.defineProperty(element, 'matches', {
    configurable: true,
    value: (selector: string): boolean => (selector === ':focus-visible' ? answer() : matches(selector)),
  });
}

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

describe('tooltip accessibility contract', () => {
  // The tooltip sits six pixels above the trigger and overlaps the neighbouring trigger.
  const TRIGGER_RECT = { left: 100, top: 100, right: 140, bottom: 140 };
  const TOOLTIP_RECT = { left: 80, top: 64, right: 160, bottom: 94 };
  const NEXT_TRIGGER_RECT = { left: 100, top: 64, right: 140, bottom: 88 };
  const TRANSIT_LIMIT_MS = 150; // The existing grace period across the six-pixel gap.

  function rect(element: HTMLElement, bounds: typeof TRIGGER_RECT): void {
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
      ...bounds,
      x: bounds.left,
      y: bounds.top,
      width: bounds.right - bounds.left,
      height: bounds.bottom - bounds.top,
      toJSON: () => bounds,
    });
  }

  function pointer(
    type: string,
    target: Element,
    relatedTarget: EventTarget | null = null,
    clientX = 120,
    clientY = 120,
  ): void {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget, clientX, clientY }));
  }

  function move(clientX: number, clientY: number, target: Element = document.body): void {
    pointer('pointermove', target, null, clientX, clientY);
  }

  function install(): HTMLElement {
    handle = installTooltips(root);
    const tooltip = root.querySelector<HTMLElement>('.a11y-tooltip')!;
    rect(btn1, TRIGGER_RECT);
    rect(btn2, NEXT_TRIGGER_RECT);
    rect(tooltip, TOOLTIP_RECT);
    return tooltip;
  }

  function hover(): HTMLElement {
    const tooltip = install();
    pointer('pointerover', btn1);
    expect(tooltip.hidden).toBe(false);
    return tooltip;
  }

  it('keeps text through the gap and while hovering the tooltip, then hides after leaving both', () => {
    const tooltip = hover();
    pointer('pointerout', btn1, root);
    // A short journey across the existing gap must not blank the text.
    vi.advanceTimersByTime(SHORT_TRANSIT_MS);
    expect(tooltip.hidden).toBe(false);
    // A non-interactive tooltip receives no events: the underlying page does.
    move(90, 80);
    vi.runAllTimers();
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.textContent).toBe('First tooltip');
    expect(btn1.getAttribute('aria-describedby')).toBe(tooltip.id);
    move(10, 10);
    vi.advanceTimersByTime(TRANSIT_LIMIT_MS - 1);
    expect(tooltip.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(tooltip.hidden).toBe(true);
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
  });

  it('keeps direct trigger-to-tooltip and return transit visible', () => {
    const tooltip = hover();
    pointer('pointerout', btn1, root);
    move(90, 80);
    vi.runAllTimers();
    expect(tooltip.hidden).toBe(false);
    move(120, 97);
    vi.advanceTimersByTime(SHORT_TRANSIT_MS);
    move(120, 120);
    vi.runAllTimers();
    expect(tooltip.hidden).toBe(false);
  });

  it('keeps keyboard focus ownership after pointer leave and hides on final blur', () => {
    const tooltip = hover();
    keyboardFocus(btn1);
    pointer('pointerout', btn1, root);
    vi.runAllTimers();
    expect(tooltip.hidden).toBe(false);
    btn1.blur();
    expect(tooltip.hidden).toBe(true);
  });

  it('keeps pointer ownership after keyboard blur', () => {
    const tooltip = hover();
    keyboardFocus(btn1);
    btn1.blur();
    vi.runAllTimers();
    expect(tooltip.hidden).toBe(false);
    pointer('pointerout', btn1, root);
    vi.runAllTimers();
    expect(tooltip.hidden).toBe(true);
  });

  it('keeps tooltip hover after a focus-only trigger blurs', () => {
    const tooltip = install();
    keyboardFocus(btn1);
    move(90, 80);
    btn1.blur();
    vi.runAllTimers();
    expect(tooltip.hidden).toBe(false);
    move(10, 10);
    vi.runAllTimers();
    expect(tooltip.hidden).toBe(true);
  });

  it('lets the latest trigger own text and returns to the remaining focused trigger on hover leave', () => {
    const tooltip = hover();
    keyboardFocus(btn2);
    expect(tooltip.textContent).toBe('Second tooltip');
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
    expect(btn2.getAttribute('aria-describedby')).toBe('existing-id a11y-tooltip');
    pointer('pointerover', btn1, root);
    expect(tooltip.textContent).toBe('First tooltip');
    pointer('pointerout', btn1, root);
    vi.runAllTimers();
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.textContent).toBe('Second tooltip');
    expect(btn2.getAttribute('aria-describedby')).toBe('existing-id a11y-tooltip');
    btn2.blur();
    expect(tooltip.hidden).toBe(true);
    expect(btn2.getAttribute('aria-describedby')).toBe('existing-id');
  });

  it('keeps Escape dismissed through internal pointer events until a new hover', () => {
    const child = document.createElement('span');
    btn1.appendChild(child);
    const tooltip = hover();
    keyboardFocus(btn1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    pointer('pointerout', btn1, child);
    pointer('pointerover', child, btn1);
    vi.runAllTimers();
    expect(tooltip.hidden).toBe(true);
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
    pointer('pointerout', child, root);
    vi.runAllTimers();
    pointer('pointerover', btn1, root);
    expect(tooltip.hidden).toBe(false);
  });

  it('keeps Escape dismissed during tooltip transit and allows new keyboard focus', () => {
    const tooltip = hover();
    pointer('pointerout', btn1, root);
    move(90, 80);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    move(120, 120);
    vi.runAllTimers();
    expect(tooltip.hidden).toBe(true);
    pointer('pointerout', btn1, root);
    vi.runAllTimers();
    keyboardFocus(btn1);
    expect(tooltip.hidden).toBe(false);
  });

  it('retires the transit timer on disposal', () => {
    hover();
    pointer('pointerout', btn1, root);
    expect(vi.getTimerCount()).toBe(1);
    handle!.dispose();
    handle = null;
    expect(vi.getTimerCount()).toBe(0);
    vi.runAllTimers();
    expect(root.querySelector('.a11y-tooltip')).toBeNull();
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
  });

  it('keeps the tooltip stylesheet transparent to pointer events', () => {
    const css = readFileSync('src/ui/tooltip.css', 'utf8');
    const style = document.createElement('style');
    style.textContent = css;
    root.appendChild(style);
    const tooltip = hover();
    expect(getComputedStyle(tooltip).pointerEvents).toBe('none');
  });

  it('switches immediately to an underlying trigger even inside the tooltip rectangle', () => {
    const child = document.createElement('span');
    btn2.appendChild(child);
    const tooltip = hover();
    pointer('pointerout', btn1, root);
    move(90, 80);
    pointer('pointerover', child, root, 120, 76);
    move(120, 76, child);
    expect(tooltip.textContent).toBe('Second tooltip');
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
    expect(btn2.getAttribute('aria-describedby')).toBe('existing-id a11y-tooltip');
    vi.runAllTimers();
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.textContent).toBe('Second tooltip');
    pointer('pointerover', btn1, root);
    expect(tooltip.textContent).toBe('First tooltip');
    // Document geometry handling must also prefer the actual underlying trigger.
    move(120, 76, child);
    expect(tooltip.textContent).toBe('Second tooltip');
  });

  it('keeps the trigger rectangle hovered when only document pointermove reaches it', () => {
    const tooltip = hover();
    pointer('pointerout', btn1, root);
    move(120, 120);
    vi.runAllTimers();
    expect(tooltip.hidden).toBe(false);
    move(10, 10);
    vi.advanceTimersByTime(TRANSIT_LIMIT_MS);
    expect(tooltip.hidden).toBe(true);
  });

  it('uses both rectangle edges and starts a fresh delay after leaving the tooltip', () => {
    const tooltip = hover();
    pointer('pointerout', btn1, root);
    for (const [x, y] of [[80, 64], [160, 94], [80, 94], [160, 64]] as const) {
      move(x, y);
      vi.advanceTimersByTime(TRANSIT_LIMIT_MS);
      expect(tooltip.hidden).toBe(false);
    }
    move(161, 95);
    vi.advanceTimersByTime(TRANSIT_LIMIT_MS - 1);
    expect(tooltip.hidden).toBe(false);
    vi.advanceTimersByTime(1);
    expect(tooltip.hidden).toBe(true);
  });

  it('does not postpone hiding on repeated moves outside both rectangles', () => {
    const tooltip = hover();
    pointer('pointerout', btn1, root);
    move(90, 80);
    move(10, 10);
    vi.advanceTimersByTime(SHORT_TRANSIT_MS);
    move(20, 20);
    vi.advanceTimersByTime(TRANSIT_LIMIT_MS - SHORT_TRANSIT_MS);
    expect(tooltip.hidden).toBe(true);
  });

  it('reads the current tooltip rectangle after its layout changes', () => {
    const tooltip = hover();
    pointer('pointerout', btn1, root);
    rect(tooltip, { left: 200, top: 200, right: 280, bottom: 230 });
    move(240, 215);
    vi.runAllTimers();
    expect(tooltip.hidden).toBe(false);
    move(90, 80);
    vi.advanceTimersByTime(TRANSIT_LIMIT_MS);
    expect(tooltip.hidden).toBe(true);
  });

  it('owns one document pointermove listener only while shown, including focus and Escape', () => {
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    const tooltip = install();
    const moves = (calls: typeof added.mock.calls): typeof added.mock.calls =>
      calls.filter(([type]) => type === 'pointermove');
    expect(moves(added.mock.calls)).toHaveLength(0);

    keyboardFocus(btn1);
    expect(moves(added.mock.calls)).toHaveLength(1);
    pointer('pointerover', btn1);
    expect(moves(added.mock.calls)).toHaveLength(1);
    keyboardFocus(btn2);
    expect(moves(added.mock.calls).length - moves(removed.mock.calls).length).toBe(1);
    pointer('pointerout', btn1, root);
    vi.runAllTimers();
    btn2.blur();
    expect(tooltip.hidden).toBe(true);
    expect(moves(added.mock.calls).length - moves(removed.mock.calls).length).toBe(0);
    const timersBeforeMove = vi.getTimerCount();
    move(10, 10);
    expect(vi.getTimerCount()).toBe(timersBeforeMove);

    keyboardFocus(btn1);
    expect(moves(added.mock.calls).length - moves(removed.mock.calls).length).toBe(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(tooltip.hidden).toBe(true);
    expect(moves(added.mock.calls).length - moves(removed.mock.calls).length).toBe(0);
    expect(moves(removed.mock.calls).map(([, listener]) => listener)).toEqual(
      moves(added.mock.calls).map(([, listener]) => listener),
    );
  });

  it('removes the document pointermove listener and description on disposal while shown', () => {
    const added = vi.spyOn(document, 'addEventListener');
    const removed = vi.spyOn(document, 'removeEventListener');
    hover();
    const listener = added.mock.calls.find(([type]) => type === 'pointermove')?.[1];
    expect(listener).toBeTypeOf('function');
    move(90, 80);
    handle!.dispose();
    handle = null;
    expect(removed).toHaveBeenCalledWith('pointermove', listener);
    expect(btn1.hasAttribute('aria-describedby')).toBe(false);
    move(10, 10);
    expect(vi.getTimerCount()).toBe(0);
    expect(root.querySelector('.a11y-tooltip')).toBeNull();
  });
});
