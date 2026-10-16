// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { EntryLobby, LobbyState } from '../../src/ui/entry-lobby';
import { createLobbyMusicSwitch } from '../../src/ui/entry-lobby/music-switch';
import { installLobbyHarness, mountLobby, root, store } from '../support/entry-lobby';

// The idle pane and the Load press: mount and hydration, the activation modes, the one-shot
// guarantee, the button's aria-busy through every way a load can end, and the music
// preference the press carries.

installLobbyHarness();

describe('first-paint and initial idle semantics', () => {
  it('mounts or hydrates a labelled modal dialog in idle state', () => {
    const { lobby, element } = mountLobby();
    expect(lobby.state).toBe('idle');
    expect(element.dataset.state).toBe('idle');
    expect(element.getAttribute('role')).toBe('dialog');
    expect(element.getAttribute('aria-modal')).toBe('true');
    expect(element.getAttribute('aria-labelledby')).toBe('entry-lobby-title');
  });

  it('renders primary CTA "Load Experience" with accessible focus', () => {
    const { element } = mountLobby();
    const btn = element.querySelector<HTMLButtonElement>('#lobby-load-btn');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toContain('LOAD EXPERIENCE');
    expect(btn?.disabled).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  it('hydrates pre-existing DOM from index.html without replacing nodes', () => {
    const { lobby, element } = mountLobby({ withPreExistingDOM: true });
    expect(lobby.state).toBe('idle');
    expect(element.querySelector('#lobby-load-btn')).not.toBeNull();
    expect(element.dataset.state).toBe('idle');
  });
});

describe('no start callback before Load', () => {
  it('does not resolve waitForLoadRequest until explicit visitor action', async () => {
    const { lobby } = mountLobby();
    let resolved = false;
    void lobby.waitForLoadRequest().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(resolved).toBe(false);
    expect(lobby.state).toBe('idle');
  });
});

describe('one-shot Load activation and input modes', () => {
  it('activates via pointer click and moves synchronously to loading', async () => {
    const { lobby, element } = mountLobby();
    let loadRequested = false;
    void lobby.waitForLoadRequest().then(() => {
      loadRequested = true;
    });

    const btn = element.querySelector<HTMLButtonElement>('#lobby-load-btn')!;
    btn.click();

    expect(lobby.state).toBe('loading');
    expect(element.dataset.state).toBe('loading');
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');

    await vi.advanceTimersByTimeAsync(0);
    expect(loadRequested).toBe(true);
  });

  it('activates via keyboard Enter key', async () => {
    const { lobby, element } = mountLobby();
    let loadRequested = false;
    void lobby.waitForLoadRequest().then(() => {
      loadRequested = true;
    });

    const btn = element.querySelector<HTMLButtonElement>('#lobby-load-btn')!;
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(lobby.state).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);
    expect(loadRequested).toBe(true);
  });

  it('activates via keyboard Space key', async () => {
    const { lobby, element } = mountLobby();
    let loadRequested = false;
    void lobby.waitForLoadRequest().then(() => {
      loadRequested = true;
    });

    const btn = element.querySelector<HTMLButtonElement>('#lobby-load-btn')!;
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

    expect(lobby.state).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);
    expect(loadRequested).toBe(true);
  });

  it('executes exactly once under repeated activation (double-click/re-entry)', async () => {
    const { lobby, element } = mountLobby();
    let resolveCount = 0;
    void lobby.waitForLoadRequest().then(() => {
      resolveCount += 1;
    });

    const btn = element.querySelector<HTMLButtonElement>('#lobby-load-btn')!;
    btn.click();
    btn.click();
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(lobby.state).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);
    expect(resolveCount).toBe(1);
  });
});

describe('load button aria-busy names only the load in progress', () => {
  it('carries no aria-busy before the press', () => {
    const { element } = mountLobby();
    expect(element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.hasAttribute('aria-busy'))
      .toBe(false);
  });

  // Every state the lobby can leave loading through, including the paths that skip ready.
  const loadEnds: Array<{ label: string; state: LobbyState; end: (lobby: EntryLobby) => void }> = [
    { label: 'ready', state: 'ready-hidden', end: (lobby) => lobby.setReady() },
    { label: 'cover-to-black', state: 'cover-to-black', end: (lobby) => lobby.setCoverToBlack() },
    { label: 'black-hold', state: 'black-hold', end: (lobby) => lobby.setBlackHold() },
    { label: 'revealing', state: 'revealing', end: (lobby) => lobby.setRevealing() },
    { label: 'revealed', state: 'revealed', end: (lobby) => lobby.setRevealed() },
    { label: 'error', state: 'error', end: (lobby) => lobby.setError('Loading failed') },
    {
      label: 'unsupported',
      state: 'error',
      end: (lobby) => lobby.setUnsupported('This exhibition requires WebGPU or WebGL 2.'),
    },
    { label: 'disposal', state: 'disposed', end: (lobby) => lobby.dispose() },
  ];

  it.each(loadEnds)('clears aria-busy when the load ends in $label', ({ state, end }) => {
    const { lobby, element } = mountLobby();
    const btn = element.querySelector<HTMLButtonElement>('#lobby-load-btn')!;
    btn.click();
    expect(btn.getAttribute('aria-busy')).toBe('true');
    end(lobby);
    expect(lobby.state).toBe(state);
    expect(btn.getAttribute('aria-busy')).toBe(null);
  });
});

describe('Music preference contract in lobby', () => {
  it('exposes the live switch preference, persists toggles and stops toggling after abort', () => {
    const button = document.createElement('button');
    button.innerHTML = '<span class="music-switch__label"></span>';
    root.appendChild(button);
    store.setItem('fashion-rotunda.music', 'off');
    const controller = new AbortController();
    try {
      const music = createLobbyMusicSwitch(button, '?music=on', store, controller.signal);
      expect(music.preference).toBe('on');
      expect(button.dataset.music).toBe('armed');
      expect(button.getAttribute('aria-pressed')).toBe('true');
      expect(button.textContent).toBe('Music on');

      button.click();
      expect(music.preference).toBe('off');
      expect(store.getItem('fashion-rotunda.music')).toBe('off');
      expect(button.dataset.music).toBe('off');
      expect(button.getAttribute('aria-pressed')).toBe('false');
      expect(button.textContent).toBe('Music off');

      button.click();
      expect(music.preference).toBe('on');
      expect(store.getItem('fashion-rotunda.music')).toBe('on');
      expect(button.dataset.music).toBe('armed');
      expect(button.getAttribute('aria-pressed')).toBe('true');
      expect(button.textContent).toBe('Music on');

      controller.abort();
      button.click();
      expect(music.preference).toBe('on');
      expect(store.getItem('fashion-rotunda.music')).toBe('on');
      expect(button.textContent).toBe('Music on');
    } finally {
      controller.abort();
    }
  });

  it('initializes to on by default and allows toggling without audio engine startup', () => {
    const { element } = mountLobby();
    const musicBtn = element.querySelector<HTMLButtonElement>('.entry-lobby__music-switch')!;
    expect(musicBtn.dataset.music).toBe('armed');
    expect(musicBtn.getAttribute('aria-pressed')).toBe('true');
    expect(musicBtn.textContent).toContain('Music on');

    musicBtn.click();
    expect(musicBtn.dataset.music).toBe('off');
    expect(musicBtn.getAttribute('aria-pressed')).toBe('false');
    expect(musicBtn.textContent).toContain('Music off');
    expect(store.getItem('fashion-rotunda.music')).toBe('off');

    musicBtn.click();
    expect(musicBtn.dataset.music).toBe('armed');
    expect(musicBtn.getAttribute('aria-pressed')).toBe('true');
    expect(musicBtn.textContent).toContain('Music on');
    expect(store.getItem('fashion-rotunda.music')).toBe('on');
  });

  it('passes the chosen music preference when Load Experience is pressed', async () => {
    const { lobby, element } = mountLobby();
    const musicBtn = element.querySelector<HTMLButtonElement>('.entry-lobby__music-switch')!;
    musicBtn.click(); // turn off

    let reportedPreference = '';
    void lobby.waitForLoadRequest().then((req) => {
      reportedPreference = req.musicPreference;
    });

    const loadBtn = element.querySelector<HTMLButtonElement>('#lobby-load-btn')!;
    loadBtn.click();

    await vi.advanceTimersByTimeAsync(0);
    expect(reportedPreference).toBe('off');
  });
});
