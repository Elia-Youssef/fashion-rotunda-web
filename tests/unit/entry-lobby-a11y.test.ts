// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { bindFocusTrap, focusInitially } from '../../src/ui/entry-lobby/focus-trap';
import type { EntryLobby } from '../../src/ui/entry-lobby';
import { installLobbyHarness, mountLobby, root } from '../support/entry-lobby';

// Focus containment and keyboard ownership: the modal trap and initial focus, Tab and
// Escape through every phase until the reveal, and the stylesheet rule that keeps hidden
// lobby buttons undrawn.

installLobbyHarness();

describe('hidden lobby buttons are not drawn', () => {
  it('keeps a [hidden] rule in the stylesheet that outranks the button display rules', () => {
    const css = readFileSync('src/ui/entry-lobby.css', 'utf8');
    // The lobby's buttons carry their own display value, which silently draws a hidden button
    // again; the stylesheet must answer with a display:none rule scoped to those buttons.
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
      selector: match[1].trim(),
      body: match[2],
    }));
    const hiding = rules.filter(
      (rule) => rule.selector.includes('[hidden]') && /display:\s*none/.test(rule.body),
    );
    expect(hiding, 'a display:none rule keyed on the hidden attribute').not.toEqual([]);
    const scopedToLobbyButtons = hiding.find(
      (rule) => rule.selector.includes('.entry-lobby') && rule.selector.includes('button'),
    );
    expect(scopedToLobbyButtons, 'the hidden rule scoped to the lobby buttons').toBeDefined();
  });
});

describe('accessibility and focus containment', () => {
  it('binds modal keyboard containment directly and releases it on abort', () => {
    const dialog = document.createElement('div');
    const first = document.createElement('button');
    const last = document.createElement('button');
    const outside = document.createElement('button');
    dialog.append(first, last);
    root.append(dialog, outside);
    for (const button of [first, last]) {
      Object.defineProperty(button, 'offsetParent', { configurable: true, get: () => dialog });
    }
    const controller = new AbortController();
    let disposed = false;
    const key = (value: string, shiftKey = false): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', { key: value, shiftKey, cancelable: true });
      document.dispatchEvent(event);
      return event;
    };
    try {
      bindFocusTrap(document, dialog, controller.signal, () => disposed);
      last.focus();
      expect(key('Tab').defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);
      expect(key('Tab', true).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(last);
      outside.focus();
      expect(key('Tab').defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);
      expect(key('Escape').defaultPrevented).toBe(true);
      expect(key('Enter').defaultPrevented).toBe(false);

      first.disabled = true;
      last.hidden = true;
      outside.focus();
      expect(key('Tab').defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(outside);
      disposed = true;
      expect(key('Escape').defaultPrevented).toBe(false);
      disposed = false;
      controller.abort();
      expect(key('Escape').defaultPrevented).toBe(false);
      expect(key('Tab').defaultPrevented).toBe(false);
    } finally {
      controller.abort();
    }
  });

  it('sets initial focus directly while preserving a hydrated visitor focus', () => {
    const dialog = document.createElement('div');
    const load = document.createElement('button');
    const outside = document.createElement('button');
    dialog.appendChild(load);
    root.append(dialog, outside);

    outside.focus();
    focusInitially(document, dialog, load, true);
    expect(document.activeElement).toBe(outside);
    focusInitially(document, dialog, load, false);
    expect(document.activeElement).toBe(load);
    expect(dialog.tabIndex).toBe(-1);

    load.blur();
    focusInitially(document, dialog, load, true);
    expect(document.activeElement).toBe(load);
    load.disabled = true;
    focusInitially(document, dialog, load, false);
    expect(document.activeElement).toBe(dialog);
    outside.focus();
    focusInitially(document, dialog, null, false);
    expect(document.activeElement).toBe(dialog);
  });

  it('counts a focused control with no layout box as focusable', () => {
    const dialog = document.createElement('div');
    const moving = document.createElement('button');
    const middle = document.createElement('button');
    const end = document.createElement('button');
    dialog.append(moving, middle, end);
    root.appendChild(dialog);
    for (const button of [middle, end]) {
      Object.defineProperty(button, 'offsetParent', { configurable: true, get: () => dialog });
    }
    const controller = new AbortController();
    const key = (value: string, shiftKey = false): KeyboardEvent => {
      const event = new KeyboardEvent('keydown', { key: value, shiftKey, cancelable: true });
      document.dispatchEvent(event);
      return event;
    };
    try {
      bindFocusTrap(document, dialog, controller.signal, () => false);
      // The focused control reports no layout box (jsdom default), as a real control does
      // mid-transition; it still takes part in the wrap order.
      moving.focus();
      // Forward Tab from a focused control that is not the last one is left to the browser.
      expect(key('Tab').defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(moving);
      // Shift+Tab from it, as the first focusable, wraps to the last one.
      expect(key('Tab', true).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(end);
    } finally {
      controller.abort();
    }
  });

  it('takes initial focus when the document reports no focused element', () => {
    const dialog = document.createElement('div');
    const load = document.createElement('button');
    dialog.appendChild(load);
    root.appendChild(dialog);
    const realActiveElement = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement')!
      .get!;
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => null });
    try {
      focusInitially(document, dialog, load, true);
    } finally {
      Object.defineProperty(document, 'activeElement', {
        configurable: true,
        get: realActiveElement,
      });
    }
    expect(document.activeElement).toBe(load);
    expect(dialog.tabIndex).toBe(-1);
  });

  it('traps Tab navigation inside the lobby dialog', () => {
    const { element } = mountLobby();
    const loadBtn = element.querySelector<HTMLButtonElement>('#lobby-load-btn')!;
    const musicBtn = element.querySelector<HTMLButtonElement>('.entry-lobby__music-switch')!;
    expect(musicBtn).not.toBeNull();

    // Focus last interactive item and press Tab -> loops to first
    loadBtn.focus();
    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(tabEvent);
    expect(tabEvent.defaultPrevented).toBe(true);
  });

  it('prevents Escape from dismissing the lobby', () => {
    mountLobby();
    const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(escEvent);
    expect(escEvent.defaultPrevented).toBe(true);
  });
});

describe('lobby keyboard ownership ends at reveal', () => {
  const inputPhases = [
    'idle', 'loading', 'ready-hidden', 'cover-to-black', 'black-hold', 'revealing', 'error',
  ] as const;

  function enterPhase(lobby: EntryLobby, element: HTMLElement, phase: typeof inputPhases[number]): void {
    if (phase === 'idle') return;
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
    if (phase === 'loading') return;
    if (phase === 'error') {
      lobby.setError('Loading failed');
      return;
    }
    lobby.setReady();
    if (phase === 'ready-hidden') return;
    lobby.setCoverToBlack();
    if (phase === 'cover-to-black') return;
    lobby.setBlackHold();
    if (phase === 'black-hold') return;
    lobby.setRevealing();
  }

  function dispatchKey(key: string, shiftKey = false): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event;
  }

  it.each(inputPhases)('guards Tab and Escape during %s, then releases them at reveal and disposal', (phase) => {
    const { lobby, element } = mountLobby();
    enterPhase(lobby, element, phase);
    expect(lobby.state).toBe(phase);
    // jsdom has no layout: no control is visible, and blurring removes the active-element exception.
    (document.activeElement as HTMLElement).blur();
    expect(dispatchKey('Tab').defaultPrevented, 'Tab with no visible lobby control').toBe(true);
    expect(dispatchKey('Escape').defaultPrevented, 'Escape while the lobby owns input').toBe(true);

    lobby.setRevealed();
    expect(dispatchKey('Tab').defaultPrevented, 'Tab after reveal').toBe(false);
    expect(dispatchKey('Tab', true).defaultPrevented, 'Shift+Tab after reveal').toBe(false);
    expect(dispatchKey('Escape').defaultPrevented, 'Escape after reveal').toBe(false);
    lobby.dispose();
    expect(dispatchKey('Tab').defaultPrevented, 'Tab after disposal').toBe(false);
    expect(dispatchKey('Escape').defaultPrevented, 'Escape after disposal').toBe(false);
  });

  it.each([false, true])('wraps visible controls before reveal, then releases focus (shift=%s)', (shiftKey) => {
    const { lobby, element } = mountLobby();
    const music = element.querySelector<HTMLButtonElement>('.entry-lobby__music-switch')!;
    const load = element.querySelector<HTMLButtonElement>('#lobby-load-btn')!;
    const retry = element.querySelector<HTMLButtonElement>('#lobby-retry-btn')!;
    retry.hidden = true;
    for (const control of [music, load]) {
      Object.defineProperty(control, 'offsetParent', { configurable: true, get: () => element });
    }
    const start = shiftKey ? music : load;
    const destination = shiftKey ? load : music;
    start.focus();
    expect(dispatchKey('Tab', shiftKey).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(destination);

    lobby.setRevealed();
    const pageControl = document.createElement('button');
    root.appendChild(pageControl);
    pageControl.focus();
    expect(dispatchKey('Tab', shiftKey).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(pageControl);
  });

  it('removes every lobby global listener at reveal and at direct disposal', () => {
    // Initialize jsdom's selector engine before observing this component's registrations.
    document.querySelector('button');
    const registrations: Array<{ target: Document | Window; type: string; calls: ReturnType<typeof vi.fn> }> = [];
    for (const target of [document, window]) {
      const add = target.addEventListener;
      vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
        const calls = vi.fn((event: Event) => {
          if (typeof listener === 'function') listener.call(target, event);
          else listener?.handleEvent(event);
        });
        registrations.push({ target, type, calls });
        add.call(target, type, calls, options);
      });
    }

    function expectRemoved(): void {
      for (const { target, type, calls } of registrations) {
        calls.mockClear();
        target.dispatchEvent(new Event(type, { cancelable: true }));
        expect(calls, `${type} callback must no longer be registered`).not.toHaveBeenCalled();
      }
    }

    const { lobby } = mountLobby();
    expect(registrations.map(({ target, type }) => [target === document ? 'document' : 'window', type]))
      .toEqual([['document', 'keydown']]);
    dispatchKey('Escape');
    expect(registrations[0].calls).toHaveBeenCalledOnce();
    lobby.setRevealed();
    expectRemoved();
    lobby.setRevealed();
    lobby.dispose();
    lobby.dispose();
    expectRemoved();

    const { lobby: unrevealed } = mountLobby();
    dispatchKey('Escape');
    expect(registrations[1].calls).toHaveBeenCalledOnce();
    unrevealed.dispose();
    expectRemoved();
    expect(dispatchKey('Tab').defaultPrevented).toBe(false);
    expect(dispatchKey('Escape').defaultPrevented).toBe(false);
  });
});
