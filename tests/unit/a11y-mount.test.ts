// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountA11y } from '../../src/ui/a11y';
import type { A11yMount } from '../../src/ui/a11y';
import { ONBOARDING_STORAGE_KEY } from '../../src/ui/onboarding';

let root: HTMLElement;
let aside: HTMLElement;
let canvas: HTMLCanvasElement;
let header: HTMLElement;
let a11y: A11yMount | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();

  root = document.body;

  header = document.createElement('header');
  const musicBtn = document.createElement('button');
  musicBtn.className = 'music-switch';
  musicBtn.dataset.music = 'off';
  musicBtn.setAttribute('aria-pressed', 'false');
  header.appendChild(musicBtn);

  canvas = document.createElement('canvas');
  canvas.id = 'scene';
  canvas.dataset.look = 'wallis-dress';
  canvas.dataset.variant = 'base';

  const looks = document.createElement('nav');
  looks.id = 'looks';
  const lookBtn = document.createElement('button');
  lookBtn.dataset.look = 'zoot-suit';
  const lookLabel = document.createElement('span');
  lookLabel.className = 'catalog-strip__label';
  lookLabel.textContent = 'Zoot Suit';
  lookBtn.appendChild(lookLabel);
  looks.appendChild(lookBtn);

  aside = document.createElement('aside');
  const rotateBtn = document.createElement('button');
  rotateBtn.dataset.action = 'rotate';
  rotateBtn.setAttribute('aria-pressed', 'false');

  const lightpanel = document.createElement('section');
  lightpanel.className = 'lightpanel';
  const lightInput = document.createElement('input');
  lightInput.type = 'range';
  lightpanel.appendChild(lightInput);

  aside.append(rotateBtn, lightpanel);
  root.append(header, looks, canvas, aside);
});

afterEach(() => {
  a11y?.dispose();
  a11y = null;
  root.innerHTML = '';
  localStorage.clear();
  vi.useRealTimers();
});

describe('mountA11y', () => {
  it('sets canvas aria-label, removes role and keeps tabindex=0', () => {
    canvas.setAttribute('role', 'img');
    a11y = mountA11y({ root, aside, canvas, search: '' });

    expect(canvas.getAttribute('aria-label')).toBe(
      'Showroom. Drag to orbit, arrow keys to turn, plus and minus to zoom, Home to reset',
    );
    expect(canvas.hasAttribute('role')).toBe(false);
    expect(canvas.tabIndex).toBe(0);
  });

  it('resets onboarding storage key when ?onboarding=reset is present', () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'done');
    a11y = mountA11y({ root, aside, canvas, search: '?onboarding=reset' });

    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
  });

  it('does not start onboarding under ?e2e=1 unless onboarding=1 is passed', () => {
    a11y = mountA11y({ root, aside, canvas, search: '?e2e=1' });
    expect(root.querySelector('.onboarding-card')).toBeNull();
    a11y.dispose();

    a11y = mountA11y({ root, aside, canvas, search: '?e2e=1&onboarding=1' });
    expect(root.querySelector('.onboarding-card')).not.toBeNull();
  });

  it('speaks look changes through the polite live region', async () => {
    a11y = mountA11y({ root, aside, canvas, search: '?e2e=1' });
    const liveRegion = root.querySelector('.a11y-live-region');
    expect(liveRegion).not.toBeNull();

    canvas.dataset.look = 'zoot-suit';

    // Wait for MutationObserver callback
    await Promise.resolve();
    vi.advanceTimersByTime(500);

    expect(liveRegion?.textContent).toBe('Now showing: Zoot Suit');
  });

  it('speaks swatch changes through the polite live region', async () => {
    a11y = mountA11y({ root, aside, canvas, search: '?e2e=1' });
    const liveRegion = root.querySelector('.a11y-live-region');

    canvas.dataset.variant = 'dark';

    await Promise.resolve();
    vi.advanceTimersByTime(500);

    expect(liveRegion?.textContent).toBe('Mannequin: dark');
  });

  it('speaks turntable and music switch toggles', async () => {
    a11y = mountA11y({ root, aside, canvas, search: '?e2e=1' });
    const liveRegion = root.querySelector('.a11y-live-region');

    const rotateBtn = aside.querySelector('button[data-action="rotate"]');
    rotateBtn?.setAttribute('aria-pressed', 'true');

    await Promise.resolve();
    vi.advanceTimersByTime(500);
    expect(liveRegion?.textContent).toBe('Turntable on');

    const musicBtn = header.querySelector('button.music-switch');
    musicBtn?.setAttribute('aria-pressed', 'true');

    await Promise.resolve();
    vi.advanceTimersByTime(500);
    expect(liveRegion?.textContent).toBe('Music on');
  });

  it.each([
    { retainedLobby: false, enabled: true },
    { retainedLobby: false, enabled: false },
    { retainedLobby: true, enabled: true },
    { retainedLobby: true, enabled: false },
  ])(
    'announces music enabled=$enabled with retained lobby=$retainedLobby',
    async ({ retainedLobby, enabled }) => {
      if (retainedLobby) {
        const lobby = document.createElement('div');
        lobby.hidden = true;
        const lobbyHeader = document.createElement('header');
        const lobbyMusicBtn = document.createElement('button');
        lobbyMusicBtn.className = 'entry-lobby__music-switch';
        lobbyMusicBtn.dataset.music = 'armed';
        lobbyMusicBtn.setAttribute('aria-pressed', 'true');
        lobbyHeader.appendChild(lobbyMusicBtn);
        lobby.appendChild(lobbyHeader);
        root.prepend(lobby);
      }

      const musicBtn = header.querySelector<HTMLButtonElement>('button.music-switch');
      expect(musicBtn).not.toBeNull();
      musicBtn?.setAttribute('aria-pressed', String(!enabled));
      if (musicBtn !== null) musicBtn.dataset.music = enabled ? 'off' : 'on';

      a11y = mountA11y({ root, aside, canvas, search: '?e2e=1' });
      const liveRegion = root.querySelector('.a11y-live-region');
      expect(liveRegion).not.toBeNull();

      musicBtn?.setAttribute('aria-pressed', String(enabled));
      if (musicBtn !== null) musicBtn.dataset.music = enabled ? 'on' : 'off';

      await Promise.resolve();
      vi.runOnlyPendingTimers();

      expect(liveRegion?.textContent).toBe(enabled ? 'Music on' : 'Music off');
    },
  );
});
