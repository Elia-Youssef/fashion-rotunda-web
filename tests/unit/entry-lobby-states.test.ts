// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { installLobbyHarness, mountLobby, root } from '../support/entry-lobby';

// The lobby state machine after the Load press: the reveal handshake from ready-hidden to
// revealed, the error and unsupported surfaces on both paths, and disposal.

installLobbyHarness();

describe('ready-hidden state', () => {
  it('transitions to ready-hidden and remains fully opaque', async () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();

    let readyResolved = false;
    void lobby.waitUntilReadyHidden().then(() => {
      readyResolved = true;
    });

    lobby.setReady();
    expect(lobby.state).toBe('ready-hidden');
    expect(element.dataset.state).toBe('ready-hidden');

    await vi.advanceTimersByTimeAsync(0);
    expect(readyResolved).toBe(true);

    // Lobby remains in DOM, not removed, not hidden, fully opaque
    expect(root.querySelector('#entry-lobby')).not.toBeNull();
    expect(element.hidden).toBe(false);
  });
});

describe('error state and clean retry', () => {
  it('displays error pane, sets message, and focuses retry button', () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();

    lobby.setError('Connection lost during asset download');
    expect(lobby.state).toBe('error');
    expect(element.dataset.state).toBe('error');

    const errMessage = element.querySelector('.entry-lobby__error-message');
    expect(errMessage?.textContent).toBe('Connection lost during asset download');

    const retryBtn = element.querySelector<HTMLButtonElement>('#lobby-retry-btn');
    expect(retryBtn).not.toBeNull();
    expect(document.activeElement).toBe(retryBtn);
  });

  it('keeps the error pane when a ready arrives after the failure', () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();

    lobby.setError('Connection lost during asset download');
    lobby.setReady();

    expect(lobby.state).toBe('error');
    expect(element.dataset.state).toBe('error');
    expect(element.querySelector<HTMLElement>('.entry-lobby__error-pane')!.hidden).toBe(false);
    expect(element.querySelector('.entry-lobby__error-message')?.textContent)
      .toBe('Connection lost during asset download');
  });
});

describe('error pane is announced once on every error path', () => {
  function paneOf(element: HTMLElement): HTMLElement {
    const pane = element.querySelector<HTMLElement>('.entry-lobby__error-pane');
    if (pane === null) {
      throw new Error('entry-lobby error pane not found');
    }
    return pane;
  }

  // A live region announces only changes that happen while it is rendered, so the order the
  // pane mutates in decides how many announcements a screen reader makes. The recorder keeps
  // that order: which text was written, when the alert role landed, when the pane appeared.
  function recordPaneMutations(pane: HTMLElement): string[] {
    const order: string[] = [];
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes' && record.attributeName !== null) {
          if (record.target === pane) {
            order.push(record.attributeName === 'hidden' ? 'pane shown' : 'pane role');
          } else {
            order.push('other hidden');
          }
        } else {
          order.push(`text: ${(record.target as HTMLElement).className}`);
        }
      }
    }).observe(pane, {
      attributes: true,
      attributeFilter: ['hidden', 'role'],
      attributeOldValue: true,
      childList: true,
      characterData: true,
      subtree: true,
    });
    return order;
  }

  it.each([false, true])('gives the load failure the alert role and its message (hydration=%s)',
    (withPreExistingDOM) => {
      const { lobby, element } = mountLobby({ withPreExistingDOM });
      element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
      const pane = paneOf(element);
      expect(pane.hasAttribute('role')).toBe(false);
      lobby.setError('Connection lost during asset download');
      expect(pane.hidden).toBe(false);
      expect(pane.getAttribute('role')).toBe('alert');
      expect(pane.querySelector('.entry-lobby__error-message')?.textContent)
        .toBe('Connection lost during asset download');
    });

  it('writes the message and the alert role before the pane appears on the failure path', async () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
    const pane = paneOf(element);
    const order = recordPaneMutations(pane);
    lobby.setError('Connection lost during asset download');
    await vi.advanceTimersByTimeAsync(0);
    const shownAt = order.indexOf('pane shown');
    expect(shownAt).toBeGreaterThan(-1);
    expect(order.lastIndexOf('text: entry-lobby__error-message'), 'message before the pane appears')
      .toBeLessThan(shownAt);
    const roleAt = order.indexOf('pane role');
    expect(roleAt, 'the alert role is set').toBeGreaterThan(-1);
    expect(roleAt, 'alert role before the pane appears').toBeLessThan(shownAt);
  });

  it('writes the title and message before the pane appears on the unsupported path', async () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
    const pane = paneOf(element);
    const order = recordPaneMutations(pane);
    lobby.setUnsupported('This exhibition requires WebGPU or WebGL 2.');
    await vi.advanceTimersByTimeAsync(0);
    const shownAt = order.indexOf('pane shown');
    expect(shownAt).toBeGreaterThan(-1);
    expect(order.lastIndexOf('text: entry-lobby__error-title'), 'title before the pane appears')
      .toBeLessThan(shownAt);
    expect(order.lastIndexOf('text: entry-lobby__error-message'), 'message before the pane appears')
      .toBeLessThan(shownAt);
  });

  it('keeps the pane an alert when a later failure replaces the message', () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
    const pane = paneOf(element);
    lobby.setError('First failure');
    lobby.setError('Second failure');
    expect(pane.hidden).toBe(false);
    expect(pane.getAttribute('role')).toBe('alert');
    expect(pane.querySelector('.entry-lobby__error-message')?.textContent).toBe('Second failure');
  });

  it('shows a failure another surface announces without the alert role', () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
    const pane = paneOf(element);
    lobby.setError('The graphics device was lost.', { announce: false });
    expect(pane.hidden).toBe(false);
    expect(pane.hasAttribute('role')).toBe(false);
    expect(pane.querySelector('.entry-lobby__error-message')?.textContent).toBe('The graphics device was lost.');
  });

  it('drops the alert role before the message changes when a later failure is announced elsewhere', async () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
    const pane = paneOf(element);
    lobby.setError('Connection lost during asset download');
    await vi.advanceTimersByTimeAsync(0);
    const order = recordPaneMutations(pane);
    lobby.setError('The graphics device was lost.', { announce: false });
    await vi.advanceTimersByTimeAsync(0);
    const roleAt = order.indexOf('pane role');
    expect(roleAt, 'the alert role is removed').toBeGreaterThan(-1);
    expect(roleAt, 'role removed before the message changes')
      .toBeLessThan(order.indexOf('text: entry-lobby__error-message'));
    expect(pane.hasAttribute('role')).toBe(false);
  });
});

describe('unsupported surface after the Load press', () => {
  const message = 'This exhibition requires WebGPU or WebGL 2.';

  it('ends on the 3D-unavailable pane with Load disabled and the retry gone', () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();

    lobby.setUnsupported(message);

    expect(lobby.state).toBe('error');
    expect(element.dataset.state).toBe('error');
    const pane = element.querySelector<HTMLElement>('.entry-lobby__error-pane')!;
    expect(pane.hidden).toBe(false);
    expect(pane.getAttribute('role')).toBe('alert');
    expect(pane.querySelector('.entry-lobby__error-title')?.textContent).toBe('3D unavailable');
    expect(pane.querySelector('.entry-lobby__error-message')?.textContent).toBe(message);
    expect(element.querySelector<HTMLElement>('.entry-lobby__loading-pane')!.hidden).toBe(true);
    expect(element.querySelector<HTMLElement>('.entry-lobby__idle-pane')!.hidden).toBe(true);
    expect(element.querySelector<HTMLButtonElement>('#lobby-retry-btn')!.hidden).toBe(true);
    expect(element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.disabled).toBe(true);
  });

  it('describes the disabled Load button with the pane message', () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();

    lobby.setUnsupported(message);

    const describedBy = element
      .querySelector<HTMLButtonElement>('#lobby-load-btn')!
      .getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy!);
    expect(description?.textContent).toBe(message);
    expect(description?.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull();
  });

  it('shows a given hint as a second line inside the alert and in the Load description', () => {
    const hint = 'Turning on graphics acceleration often fixes this.';
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
    const pane = element.querySelector<HTMLElement>('.entry-lobby__error-pane')!;
    const hintLine = pane.querySelector<HTMLElement>('.entry-lobby__error-hint')!;
    expect(hintLine.hidden).toBe(true);

    lobby.setUnsupported(message, hint);

    expect(hintLine.hidden).toBe(false);
    expect(hintLine.textContent).toBe(hint);
    const ids = element
      .querySelector<HTMLButtonElement>('#lobby-load-btn')!
      .getAttribute('aria-describedby')!
      .split(' ');
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([message, hint]);
  });

  it('keeps the hint line hidden and out of the description without a hint', () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();

    lobby.setUnsupported(message);

    expect(element.querySelector<HTMLElement>('.entry-lobby__error-hint')!.hidden).toBe(true);
    expect(element.querySelector('#lobby-load-btn')!.getAttribute('aria-describedby'))
      .toBe('lobby-unsupported-message');
  });

  it('is terminal: a later ready does not replace the unsupported pane', () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();

    lobby.setUnsupported(message);
    lobby.setReady();

    expect(lobby.state).toBe('error');
    expect(element.querySelector<HTMLElement>('.entry-lobby__error-pane')!.hidden).toBe(false);
    expect(element.querySelector<HTMLButtonElement>('#lobby-retry-btn')!.hidden).toBe(true);
    expect(element.querySelector('.entry-lobby__error-title')?.textContent).toBe('3D unavailable');
  });
});

describe('unsupported browser behavior', () => {
  it.each([false, true])('exposes the support explanation as an alert (hydration=%s)', (withPreExistingDOM) => {
    const message = 'This exhibition requires WebGPU or WebGL 2.';
    const { element } = mountLobby({ unsupportedMessage: message, withPreExistingDOM });
    const pane = element.querySelector<HTMLElement>('.entry-lobby__error-pane')!;
    expect(pane.hidden).toBe(false);
    expect(pane.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull();
    expect(pane.getAttribute('role')).toBe('alert');
    expect(pane.querySelector('.entry-lobby__error-message')?.textContent).toBe(message);
    expect(pane.querySelector<HTMLButtonElement>('#lobby-retry-btn')!.hidden).toBe(true);
  });

  it.each([false, true])('describes disabled Load and prevents startup (hydration=%s)', async (withPreExistingDOM) => {
    const message = 'This exhibition requires WebGPU or WebGL 2.';
    const { lobby, element } = mountLobby({ unsupportedMessage: message, withPreExistingDOM });
    const button = element.querySelector<HTMLButtonElement>('#lobby-load-btn')!;
    expect(button.disabled).toBe(true);
    const descriptionId = button.getAttribute('aria-describedby');
    expect(descriptionId).toBeTruthy();
    const description = document.getElementById(descriptionId!);
    expect(description?.textContent).toBe(message);
    expect(description?.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull();
    let started = false;
    void lobby.waitForLoadRequest().then(() => { started = true; });
    button.click();
    for (const key of ['Enter', ' ']) {
      button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(false);
    expect(lobby.state).toBe('idle');
  });

  it.each([false, true])('preserves supported lobby startup (hydration=%s)', async (withPreExistingDOM) => {
    const { lobby, element } = mountLobby({ withPreExistingDOM });
    const pane = element.querySelector<HTMLElement>('.entry-lobby__error-pane')!;
    const button = element.querySelector<HTMLButtonElement>('#lobby-load-btn')!;
    expect(pane.hidden).toBe(true);
    expect(pane.hasAttribute('role')).toBe(false);
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    expect(element.querySelector<HTMLButtonElement>('#lobby-retry-btn')!.hidden).toBe(false);
    expect(document.activeElement).toBe(button);
    const request = lobby.waitForLoadRequest();
    button.click();
    expect(lobby.state).toBe('loading');
    expect(element.querySelector<HTMLElement>('.entry-lobby__loading-pane')!.hidden).toBe(false);
    await expect(request).resolves.toEqual({ musicPreference: 'on' });
  });

  it('disables Load Experience and shows support message when neither WebGPU nor WebGL 2 exists', () => {
    const { lobby, element } = mountLobby({
      unsupportedMessage: 'This exhibition requires WebGPU or WebGL 2.',
    });
    expect(lobby.state).toBe('idle');
    const loadBtn = element.querySelector<HTMLButtonElement>('#lobby-load-btn')!;
    expect(loadBtn.disabled).toBe(true);
    expect(element.querySelector('.entry-lobby__error-message')?.textContent).toBe(
      'This exhibition requires WebGPU or WebGL 2.',
    );
  });
});

describe('disposal', () => {
  it('stops active progress tracking at reveal without requiring a ready call', () => {
    const disconnect = vi.fn();
    vi.stubGlobal('PerformanceObserver', class {
      observe(): void {}
      disconnect = disconnect;
    });
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
    try {
      const { lobby } = mountLobby();
      const timers = vi.getTimerCount();
      const stop = lobby.trackProgress('/reveal-progress');
      expect(vi.getTimerCount()).toBe(timers + 1);
      lobby.setRevealed();
      expect(disconnect).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(timers);
      stop();
      lobby.dispose();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([false, true])(
    'releases the revealed surface while retaining its state (hydration=%s)',
    async (withPreExistingDOM) => {
      const signals: AbortSignal[] = [];
      const add = HTMLButtonElement.prototype.addEventListener;
      vi.spyOn(HTMLButtonElement.prototype, 'addEventListener').mockImplementation(function (
        this: HTMLButtonElement, type, listener, options,
      ) {
        if (typeof options === 'object' && options.signal) signals.push(options.signal);
        add.call(this, type, listener, options);
      });
      const failed = mountLobby({ withPreExistingDOM });
      failed.element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
      failed.lobby.setError('Connection lost');
      failed.lobby.setReady();
      expect(failed.lobby.state).toBe('error');
      expect(failed.element.isConnected).toBe(true);
      expect(failed.element.querySelector<HTMLElement>('.entry-lobby__error-pane')!.hidden).toBe(false);
      expect(document.activeElement).toBe(failed.element.querySelector('#lobby-retry-btn'));
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      failed.lobby.dispose();
      signals.length = 0;

      const { lobby, element } = mountLobby({ withPreExistingDOM });
      const music = element.querySelector<HTMLButtonElement>('.entry-lobby__music-switch')!;
      const load = element.querySelector<HTMLButtonElement>('#lobby-load-btn')!;
      const preference = music.getAttribute('aria-pressed');
      load.click();
      const request = await lobby.waitForLoadRequest();
      lobby.setReady();
      lobby.setCoverToBlack();
      lobby.setBlackHold();
      lobby.setRevealing();
      expect(element.isConnected).toBe(true);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      lobby.setRevealed();
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(element.isConnected).toBe(false);
      expect(root.querySelector('#entry-lobby')).toBeNull();
      expect(lobby.state).toBe('revealed');
      expect(lobby.element).toBe(element);
      expect(element.dataset.state).toBe('revealed');
      music.click();
      expect(music.getAttribute('aria-pressed')).toBe(preference);
      expect(await lobby.waitForLoadRequest()).toEqual(request);
      lobby.setRevealed();
      expect(lobby.state).toBe('revealed');
      lobby.dispose();
      expect(lobby.state).toBe('disposed');
    },
  );

  it('removes lobby from DOM and sets state to disposed', () => {
    const { lobby } = mountLobby();
    lobby.dispose();
    expect(lobby.state).toBe('disposed');
    expect(root.querySelector('#entry-lobby')).toBeNull();
  });
});

describe('entry lobby transition handshake', () => {
  it('transitions through cover-to-black, black-hold, revealing, and revealed', () => {
    const { lobby, element } = mountLobby();
    expect(lobby.element).toBe(element);

    lobby.setReady();
    expect(lobby.state).toBe('ready-hidden');
    expect(element.dataset.state).toBe('ready-hidden');

    lobby.setCoverToBlack();
    expect(lobby.state).toBe('cover-to-black');
    expect(element.dataset.state).toBe('cover-to-black');

    lobby.setBlackHold();
    expect(lobby.state).toBe('black-hold');
    expect(element.dataset.state).toBe('black-hold');

    lobby.setRevealing();
    expect(lobby.state).toBe('revealing');
    expect(element.dataset.state).toBe('revealing');

    lobby.setRevealed();
    expect(lobby.state).toBe('revealed');
    expect(element.dataset.state).toBe('revealed');
    expect(element.hidden).toBe(true);
    expect(element.getAttribute('inert')).toBe('');
    expect(element.getAttribute('aria-hidden')).toBe('true');
  });

  it('prepareForReveal keeps the lobby as the cover until the veil takes ownership', () => {
    const { lobby, element } = mountLobby();
    lobby.prepareForReveal();
    expect(element.style.pointerEvents).toBe('');
  });
});
