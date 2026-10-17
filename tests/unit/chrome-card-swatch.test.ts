// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { OTHER, actions, button, makeLook, mount, root, swatch } from '../support/chrome-card';

// The swatch row as a radio group: the check and the single tab stop, the focus contract across
// look replacements and clearing, and the keyboard navigation between members.

describe('swatch accessibility contract', () => {
  it.each([
    ['same variants', ['base', 'light', 'dark'], 'dark', 'light'],
    ['reordered variants', ['dark', 'base', 'light'], 'dark', 'light'],
    ['removed variant with checked fallback', ['base', 'dark'], 'dark', 'dark'],
    ['removed variant with first fallback', ['dark', 'base'], null, 'dark'],
    ['removed variant with unknown selection', ['dark', 'base'], 'missing', 'dark'],
  ] as const)('preserves focus for %s and keeps arrow navigation working', (_, variants, selected, expected) => {
    const handlers = actions();
    const handle = mount({ handlers });
    swatch('light').focus();
    handle.setLook(makeLook('replacement', 'Replacement', [...variants]), selected);
    expect(document.activeElement).toBe(swatch(expected));
    const order: readonly string[] = variants;
    const next = order[(order.indexOf(expected) + 1) % order.length];
    swatch(expected).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(swatch(next));
    expect(handlers.material).toHaveBeenCalledExactlyOnceWith(next);
    expect(swatch(next).getAttribute('aria-checked')).toBe('true');
  });

  it.each(['no look', 'empty variants'] as const)('keeps a keyboard destination for %s', (empty) => {
    const handle = mount();
    swatch('light').focus();
    handle.setLook(empty === 'no look' ? null : makeLook('empty', 'Empty', []), null);
    expect(root.querySelectorAll('[role="radio"]')).toHaveLength(0);
    expect(document.activeElement).toBe(button('Material'));
  });

  it.each(['outside card', 'card action'] as const)('leaves focus on %s during replacement and clearing', (where) => {
    const handle = mount();
    const outside = document.createElement('button');
    root.appendChild(outside);
    const focused = where === 'outside card' ? outside : button('Reset');
    focused.focus();
    handle.setLook(OTHER, 'dark');
    expect(document.activeElement).toBe(focused);
    handle.setLook(null, null);
    expect(document.activeElement).toBe(focused);
  });
});

describe('the swatch row as a radio group', () => {
  it('moves the check with a swatch click, leaving one tab stop', () => {
    mount({ variant: 'base' });
    swatch('dark').click();
    expect(swatch('dark').getAttribute('aria-checked')).toBe('true');
    expect(swatch('dark').tabIndex).toBe(0);
    expect(swatch('base').getAttribute('aria-checked')).toBe('false');
    expect(swatch('base').tabIndex).toBe(-1);
    expect(swatch('light').getAttribute('aria-checked')).toBe('false');
  });

  it('keeps one checked member and the tab stop for a name this look does not carry', () => {
    const handle = mount({ variant: 'base' });
    handle.setVariant('missing');
    expect(swatch('base').getAttribute('aria-checked')).toBe('true');
    expect(swatch('base').tabIndex).toBe(0);
    expect(swatch('light').getAttribute('aria-checked')).toBe('false');
    expect(swatch('light').tabIndex).toBe(-1);
    expect(swatch('dark').getAttribute('aria-checked')).toBe('false');
  });
});

describe('keyboard navigation in the swatch row', () => {
  function press(key: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    root.querySelector('.product-card__swatches')?.dispatchEvent(event);
    return event;
  }

  it('moves with all four arrow keys and wraps at the first member', () => {
    const handlers = actions();
    mount({ handlers, variant: 'base' });
    swatch('base').focus();

    press('ArrowDown');
    expect(handlers.material).toHaveBeenLastCalledWith('light');
    expect(document.activeElement).toBe(swatch('light'));

    press('ArrowUp');
    expect(handlers.material).toHaveBeenLastCalledWith('base');
    expect(document.activeElement).toBe(swatch('base'));

    press('ArrowRight');
    expect(handlers.material).toHaveBeenLastCalledWith('light');
    expect(document.activeElement).toBe(swatch('light'));

    press('ArrowLeft');
    expect(handlers.material).toHaveBeenLastCalledWith('base');
    expect(document.activeElement).toBe(swatch('base'));

    press('ArrowLeft');
    expect(handlers.material).toHaveBeenLastCalledWith('dark');
    expect(document.activeElement).toBe(swatch('dark'));
    expect(swatch('dark').getAttribute('aria-checked')).toBe('true');
  });

  it('consumes the navigation keys so the page does not act on them', () => {
    mount({ variant: 'base' });
    swatch('base').focus();
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End']) {
      expect(press(key).defaultPrevented).toBe(true);
    }
  });

  it('applies nothing when no swatch holds focus', () => {
    const handlers = actions();
    mount({ handlers, variant: 'base' });
    button('Material').focus();
    const event = press('ArrowRight');
    expect(handlers.material).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button('Material'));
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves unrelated keys to the page', () => {
    const handlers = actions();
    mount({ handlers, variant: 'base' });
    swatch('base').focus();
    const event = press('a');
    expect(event.defaultPrevented).toBe(false);
    expect(handlers.material).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(swatch('base'));
    expect(swatch('base').getAttribute('aria-checked')).toBe('true');
  });
});
