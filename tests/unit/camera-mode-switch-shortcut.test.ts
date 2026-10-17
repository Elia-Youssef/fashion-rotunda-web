// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { canvas, make, root } from '../support/camera-mode-switch';

// The O return-to-Orbit shortcut and its pointer-lock guidance: exit guidance while walking,
// the press-burst contract, modified keys, touch controls without a pointer lock, and the
// scoping contract that owns which elements may press O.

describe('mountModeSwitch', () => {
  it('shows clear pointer-lock exit guidance while walking', () => {
    const { mount, handle } = make('walk', true);
    const hint = document.body.querySelector<HTMLElement>('.archviz-walk-hint');

    expect(hint?.hidden).toBe(false);
    expect(hint?.textContent).toContain('Press Esc to release the mouse');
    expect(hint?.textContent).toContain('Press O to return to Orbit');

    void mount.setMode('orbit');
    expect(hint?.hidden).toBe(true);

    handle.dispose();
  });

  it('returns to Orbit with O while walking', () => {
    const { mount, handle } = make('walk', true);
    canvas.focus();
    const event = new KeyboardEvent('keydown', {
      code: 'KeyO',
      bubbles: true,
      cancelable: true,
    });

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(mount.setMode).toHaveBeenCalledWith('orbit');
    handle.dispose();
  });

  it('leaves O alone for modified keys and interactive controls', () => {
    const { mount, handle } = make('walk', true);
    const input = document.createElement('input');
    document.body.appendChild(input);

    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', ctrlKey: true }));

    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'plaintext-only');
    document.body.appendChild(editable);
    editable.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true }));

    expect(mount.setMode).not.toHaveBeenCalled();
    input.remove();
    editable.remove();
    handle.dispose();
  });

  it('keeps pointer-lock guidance and its shortcut off touch Walk controls', () => {
    const { mount, handle } = make('walk', true, false);
    const hint = document.body.querySelector<HTMLElement>('.archviz-walk-hint');

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO' }));

    expect(hint?.hidden).toBe(true);
    expect(mount.setMode).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('defaults to pointer-lock ownership when the option is omitted', () => {
    const { mount, handle } = make('walk', true, undefined);
    const hint = document.body.querySelector<HTMLElement>('.archviz-walk-hint')!;

    expect(hint.hidden).toBe(false);
    canvas.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true, cancelable: true }));

    expect(mount.setMode).toHaveBeenCalledWith('orbit');
    handle.dispose();
  });

  it('fires O once per press burst and rearms it once the switch settles', async () => {
    const { mount, handle } = make('walk');
    vi.mocked(mount.setMode).mockImplementation(async () => {});
    canvas.focus();
    const press = () => window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyO', bubbles: true, cancelable: true,
    }));

    press();
    press();
    expect(mount.setMode).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => { setTimeout(resolve, 0); });
    press();
    expect(mount.setMode).toHaveBeenCalledTimes(2);
    handle.dispose();
  });

  describe('shortcut accessibility contract', () => {
    it.each([
      ['body', false, false],
      ['guide', false, false],
      ['canvas', false, true],
      ['body', true, true],
      ['guide', true, true],
      ['canvas', true, true],
      ['input', false, false],
      ['input', true, false],
      ['textarea', false, false],
      ['textarea', true, false],
      ['select', false, false],
      ['select', true, false],
      ['button', false, false],
      ['button', true, false],
      ['a', false, false],
      ['a', true, false],
      ['editable', false, false],
      ['editable', true, false],
      ['foreign canvas', false, false],
      ['foreign canvas', true, false],
    ] as const)('scopes O from %s with pointer lock %s to scene ownership %s', (source, locked, allowed) => {
      const { mount, handle } = make('walk');
      const target = source === 'canvas' ? canvas : source === 'body' ? document.body :
        document.createElement(source === 'guide' || source === 'editable' ? 'div' :
          source === 'foreign canvas' ? 'canvas' : source);
      if (target !== canvas && target !== document.body) root.appendChild(target);
      if (source === 'editable') target.setAttribute('contenteditable', 'plaintext-only');
      target.tabIndex = 0;
      target.focus();
      vi.spyOn(document, 'pointerLockElement', 'get').mockReturnValue(
        locked ? source === 'foreign canvas' ? target : canvas : null,
      );
      const event = new KeyboardEvent('keydown', { code: 'KeyO', bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(allowed);
      if (allowed) expect(mount.setMode).toHaveBeenCalledExactlyOnceWith('orbit');
      else expect(mount.setMode).not.toHaveBeenCalled();
      handle.dispose();
    });

    it.each([false, true].flatMap((locked) =>
      (['altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'repeat'] as const).map((modifier) =>
        [modifier, locked] as const),
    ))('leaves %s O alone with pointer lock %s', (modifier, locked) => {
        const { mount, handle } = make('walk');
        canvas.focus();
        vi.spyOn(document, 'pointerLockElement', 'get').mockReturnValue(locked ? canvas : null);
        const event = new KeyboardEvent('keydown', {
          code: 'KeyO', bubbles: true, cancelable: true, [modifier]: true,
        });
        canvas.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(mount.setMode).not.toHaveBeenCalled();
        handle.dispose();
    });
  });
});
