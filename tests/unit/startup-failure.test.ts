// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountEntryLobby } from '../../src/ui/entry-lobby';
import type { EntryLobby, LobbyState } from '../../src/ui/entry-lobby';
import {
  createStartupFailureRouting,
  showStartupNotice,
  STARTUP_FAILURE_MESSAGE,
} from '../../src/ui/startup-failure';

const mountedLobbies: EntryLobby[] = [];

function mountLobby(): { lobby: EntryLobby; element: HTMLElement } {
  const lobby = mountEntryLobby({ root: document.body, search: '' });
  mountedLobbies.push(lobby);
  const element = document.querySelector<HTMLElement>('#entry-lobby');
  if (element === null) {
    throw new Error('entry-lobby element not found');
  }
  return { lobby, element };
}

function pressLoad(element: HTMLElement): void {
  element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
}

/** Drives a freshly mounted lobby to the given state along the real transition order. */
function driveToState(lobby: EntryLobby, state: LobbyState): void {
  if (state === 'idle') {
    return;
  }
  pressLoad(lobby.element);
  if (state === 'loading') {
    return;
  }
  lobby.setReady();
  if (state === 'ready-hidden') {
    return;
  }
  lobby.setCoverToBlack();
  if (state === 'cover-to-black') {
    return;
  }
  lobby.setBlackHold();
  if (state === 'black-hold') {
    return;
  }
  lobby.setRevealing();
}

afterEach(() => {
  mountedLobbies.splice(0).forEach((lobby) => lobby.dispose());
  document.body.innerHTML = '';
});

describe('createStartupFailureRouting', () => {
  it('routes a failure to the lobby error pane while the lobby owns the screen', () => {
    const { lobby, element } = mountLobby();
    pressLoad(element);
    const routing = createStartupFailureRouting({ lobby: () => lobby });

    routing.fail();

    expect(routing.failed).toBe(true);
    expect(lobby.state).toBe('error');
    const pane = element.querySelector<HTMLElement>('.entry-lobby__error-pane')!;
    expect(pane.hidden).toBe(false);
    expect(pane.querySelector('.entry-lobby__error-message')?.textContent)
      .toBe(STARTUP_FAILURE_MESSAGE);
    // A failed startup keeps its retry: reloading is the recovery the pane offers.
    expect(element.querySelector<HTMLButtonElement>('#lobby-retry-btn')!.hidden).toBe(false);
  });

  it('appends a DOM notice on the page body when no lobby exists', () => {
    const routing = createStartupFailureRouting({ lobby: () => null });

    routing.fail();

    const notice = document.body.querySelector<HTMLElement>('.startup-notice');
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(notice?.querySelector('.startup-notice__title')?.textContent)
      .toBe('Showroom could not load');
    expect(notice?.querySelector('.startup-notice__message')?.textContent)
      .toBe(STARTUP_FAILURE_MESSAGE);
    expect(notice?.querySelector('.startup-notice__reload')?.textContent).toBe('Reload');
  });

  it('latches: the first failure owns the surface and a second one changes nothing', () => {
    const { lobby, element } = mountLobby();
    pressLoad(element);
    let current: EntryLobby | null = lobby;
    const routing = createStartupFailureRouting({ lobby: () => current });

    routing.fail();
    // A later failure would find no lobby and fall to the body notice; the latch must keep the
    // first surface instead.
    current = null;
    routing.fail();

    expect(document.body.querySelectorAll('.startup-notice')).toHaveLength(0);
    expect(lobby.state).toBe('error');
    const messages = element.querySelectorAll('.entry-lobby__error-message');
    expect(messages).toHaveLength(1);
  });

  it('latches with the notice too: a second failure does not stack a second notice', () => {
    const routing = createStartupFailureRouting({ lobby: () => null });

    routing.fail();
    routing.fail();

    expect(document.body.querySelectorAll('.startup-notice')).toHaveLength(1);
  });

  it('reports failed only after the first failure', () => {
    const routing = createStartupFailureRouting({ lobby: () => null });
    expect(routing.failed).toBe(false);
    routing.fail();
    expect(routing.failed).toBe(true);
  });

  it('falls back to the DOM notice once the lobby no longer owns the screen', () => {
    const { lobby } = mountLobby();
    pressLoad(lobby.element);
    lobby.setReady();
    lobby.setRevealed();
    const routing = createStartupFailureRouting({ lobby: () => lobby });

    routing.fail();

    expect(lobby.state).toBe('revealed');
    expect(document.body.querySelector('.startup-notice')).not.toBeNull();
  });

  it('falls back to the DOM notice for a disposed lobby', () => {
    const { lobby } = mountLobby();
    pressLoad(lobby.element);
    const routing = createStartupFailureRouting({ lobby: () => lobby });
    lobby.dispose();

    routing.fail();

    expect(document.body.querySelector('.startup-notice')).not.toBeNull();
  });

  // Everything before the reveal keeps the lobby as the failure surface, not only the
  // loading state: an early throw (idle), a late one during the reveal sequence, and
  // every state between them all owe the visitor the pane with its retry.
  it.each([
    'idle',
    'loading',
    'ready-hidden',
    'cover-to-black',
    'black-hold',
    'revealing',
  ] as LobbyState[])('routes a failure to the lobby pane while the lobby is %s', (state) => {
    const { lobby, element } = mountLobby();
    driveToState(lobby, state);
    const routing = createStartupFailureRouting({ lobby: () => lobby });

    routing.fail();

    expect(lobby.state).toBe('error');
    expect(element.querySelector('.entry-lobby__error-message')?.textContent)
      .toBe(STARTUP_FAILURE_MESSAGE);
    expect(document.body.querySelector('.startup-notice')).toBeNull();
  });

  it('backs the fallback notice with the caller-supplied reload action', () => {
    const reload = vi.fn();
    const routing = createStartupFailureRouting({ lobby: () => null, reload });

    routing.fail();

    // The routing resolves the reload action once; the notice it falls back to carries
    // that same action, not a page reload of its own.
    document.body.querySelector<HTMLButtonElement>('.startup-notice__reload')!.click();
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe('showStartupNotice', () => {
  it('does not stack a second notice on the same root', () => {
    const reload = vi.fn();
    showStartupNotice(document.body, reload);
    showStartupNotice(document.body, reload);

    expect(document.body.querySelectorAll('.startup-notice')).toHaveLength(1);
  });

  it('wires the Reload button to the supplied action', () => {
    const reload = vi.fn();
    showStartupNotice(document.body, reload);

    document.body.querySelector<HTMLButtonElement>('.startup-notice__reload')!.click();

    expect(reload).toHaveBeenCalledOnce();
  });

  it('reads title, message, then Reload in document order', () => {
    showStartupNotice(document.body, () => undefined);

    // The notice is a plain grid with no order overrides (startup-failure.css), so the
    // document order is the order a visitor and a screen reader meet it in.
    const notice = document.body.querySelector<HTMLElement>('.startup-notice')!;
    expect([...notice.children].map((child) => child.className)).toEqual([
      'startup-notice__title',
      'startup-notice__message',
      'startup-notice__reload',
    ]);
  });
});
