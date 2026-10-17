// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MusicState } from '../../src/audio/music';
import { mountA11y } from '../../src/ui/a11y';
import type { A11yMount } from '../../src/ui/a11y';
import { mountAnnouncer } from '../../src/ui/announce';
import type { Announcer } from '../../src/ui/announce';
import { mountMusicSwitch } from '../../src/ui/music-switch';
import type { MusicSwitchHandle } from '../../src/ui/music-switch';
import { ONBOARDING_STORAGE_KEY } from '../../src/ui/onboarding';

let root: HTMLElement;
let announcer: Announcer;
let aside: HTMLElement;
let canvas: HTMLCanvasElement;
let header: HTMLElement;
let a11y: A11yMount | null = null;
let musicSwitch: MusicSwitchHandle | null = null;

// Match the announcer's coalescing window to test completion before and after it closes.
const ANNOUNCEMENT_WINDOW_MS = 500;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();

  root = document.body;
  announcer = mountAnnouncer(root);

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
  musicSwitch?.dispose();
  musicSwitch = null;
  announcer.dispose();
  root.innerHTML = '';
  localStorage.clear();
  vi.useRealTimers();
});

describe('mountA11y', () => {
  const playbackTransitions: { initial: MusicState; next: MusicState }[] = [
    { initial: 'armed', next: 'loading' },
    { initial: 'armed', next: 'playing' },
    { initial: 'loading', next: 'playing' },
    { initial: 'playing', next: 'armed' },
    { initial: 'off', next: 'error' },
    { initial: 'error', next: 'off' },
  ];

  it.each(
    playbackTransitions.flatMap((transition) =>
      [0, ANNOUNCEMENT_WINDOW_MS].map((delay) => ({ ...transition, delay })),
    ),
  )(
    'preserves readiness for $initial -> $next after $delay ms and announces user toggles',
    async ({ initial, next, delay }) => {
      header.replaceChildren();
      let state = initial;
      musicSwitch = mountMusicSwitch(header, {
        state,
        onToggle: () => {
          state = state === 'off' || state === 'error' ? 'loading' : 'off';
          musicSwitch?.setState(state, null);
        },
      });
      const musicBtn = header.querySelector<HTMLButtonElement>('button.music-switch')!;
      a11y = mountA11y({ root, aside, canvas, announcer, search: '?e2e=1' });
      const liveRegion = root.querySelector('.a11y-live-region')!;

      a11y.announcer.say('Experience ready');
      expect(liveRegion.textContent).toBe('Experience ready');
      vi.advanceTimersByTime(delay);

      // Playback completion rewrites both attributes while the switch stays on or stays off.
      state = next;
      musicSwitch.setState(state, null);
      await Promise.resolve();
      vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);
      expect(liveRegion.textContent).toBe('Experience ready');

      // Native clicks exercise both toggle directions after automatic playback settles.
      for (let toggle = 0; toggle < 2; toggle += 1) {
        musicBtn.click();
        await Promise.resolve();
        vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);
        expect(liveRegion.textContent).toBe(state === 'off' ? 'Music off' : 'Music on');
      }
    },
  );

  it('sets canvas aria-label, removes role and keeps tabindex=0', () => {
    canvas.setAttribute('role', 'img');
    a11y = mountA11y({ root, aside, canvas, announcer, search: '' });

    expect(canvas.getAttribute('aria-label')).toBe(
      'Showroom. Drag to orbit, arrow keys to turn, plus and minus to zoom, Home to reset',
    );
    expect(canvas.hasAttribute('role')).toBe(false);
    expect(canvas.tabIndex).toBe(0);
  });

  it('resets onboarding storage key when ?onboarding=reset is present', () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'done');
    a11y = mountA11y({ root, aside, canvas, announcer, search: '?onboarding=reset' });

    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
  });

  it('does not start onboarding under ?e2e=1 unless onboarding=1 is passed', () => {
    a11y = mountA11y({ root, aside, canvas, announcer, search: '?e2e=1' });
    expect(root.querySelector('.onboarding-card')).toBeNull();
    a11y.dispose();

    a11y = mountA11y({ root, aside, canvas, announcer, search: '?e2e=1&onboarding=1' });
    expect(root.querySelector('.onboarding-card')).not.toBeNull();
  });

  it('speaks look changes through the polite live region', async () => {
    a11y = mountA11y({ root, aside, canvas, announcer, search: '?e2e=1' });
    const liveRegion = root.querySelector('.a11y-live-region');
    expect(liveRegion).not.toBeNull();

    canvas.dataset.look = 'zoot-suit';

    // Wait for MutationObserver callback
    await Promise.resolve();
    vi.advanceTimersByTime(500);

    expect(liveRegion?.textContent).toBe('Now showing: Zoot Suit');
  });

  it('speaks swatch changes through the polite live region', async () => {
    a11y = mountA11y({ root, aside, canvas, announcer, search: '?e2e=1' });
    const liveRegion = root.querySelector('.a11y-live-region');

    canvas.dataset.variant = 'dark';

    await Promise.resolve();
    vi.advanceTimersByTime(500);

    expect(liveRegion?.textContent).toBe('Mannequin: Dark charcoal');
  });

  it('speaks turntable and music switch toggles', async () => {
    a11y = mountA11y({ root, aside, canvas, announcer, search: '?e2e=1' });
    const liveRegion = root.querySelector('.a11y-live-region');

    const rotateBtn = aside.querySelector('button[data-action="rotate"]');
    rotateBtn?.setAttribute('aria-pressed', 'true');

    await Promise.resolve();
    vi.advanceTimersByTime(500);
    expect(liveRegion?.textContent).toBe('Rotate on');

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

      a11y = mountA11y({ root, aside, canvas, announcer, search: '?e2e=1' });
      const liveRegion = root.querySelector('.a11y-live-region');
      expect(liveRegion).not.toBeNull();

      if (retainedLobby) {
        // A competing control inserted after mount must not change the observer's owner.
        const competingHeader = document.createElement('header');
        const competingButton = document.createElement('button');
        competingButton.className = 'music-switch';
        competingButton.setAttribute('aria-pressed', String(!enabled));
        competingButton.dataset.music = enabled ? 'off' : 'on';
        competingHeader.appendChild(competingButton);
        root.prepend(competingHeader);
      }

      musicBtn?.setAttribute('aria-pressed', String(enabled));
      if (musicBtn !== null) musicBtn.dataset.music = enabled ? 'on' : 'off';

      await Promise.resolve();
      vi.runOnlyPendingTimers();

      expect(liveRegion?.textContent).toBe(enabled ? 'Music on' : 'Music off');
    },
  );

  it('keeps stored onboarding completion on a visit without the reset parameter', () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'done');
    a11y = mountA11y({ root, aside, canvas, announcer, search: '' });

    expect(root.querySelector('.onboarding-card')).toBeNull();
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe('done');
  });

  it('tolerates a storage that refuses the onboarding reset removal', () => {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, 'done');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('storage restricted');
    });
    try {
      expect(() => {
        a11y = mountA11y({ root, aside, canvas, announcer, search: '?onboarding=reset' });
      }).not.toThrow();
    } finally {
      removeItem.mockRestore();
    }
    expect(a11y).not.toBeNull();
  });

  it('completes the orbit step on a canvas drag but not on a lone pointerup', () => {
    a11y = mountA11y({ root, aside, canvas, announcer, search: '' });
    expect(typeof a11y.onboarding.complete).toBe('function');
    const stepTitle = () => root.querySelector('.onboarding-card__title')?.textContent;
    expect(stepTitle()).toBe('Explore the room');

    window.dispatchEvent(new Event('pointerup'));
    expect(stepTitle()).toBe('Explore the room');

    canvas.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('pointerup'));
    expect(stepTitle()).toBe('Select a look');
  });

  it('completes the lights step only for input inside the light panel', async () => {
    a11y = mountA11y({ root, aside, canvas, announcer, search: '' });
    canvas.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('pointerup'));
    canvas.dataset.look = 'zoot-suit';
    await Promise.resolve();
    expect(root.querySelector('.onboarding-card__title')?.textContent).toBe('Adjust lighting');

    const outside = document.createElement('input');
    aside.appendChild(outside);
    outside.dispatchEvent(new Event('input', { bubbles: true }));
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();
    expect(root.querySelector('.onboarding-card')).not.toBeNull();

    // A text node inside the panel is not an element control, so it is not panel input either.
    const panelText = document.createTextNode('panel label');
    aside.querySelector('.lightpanel')?.appendChild(panelText);
    panelText.dispatchEvent(new Event('input', { bubbles: true }));
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBeNull();

    const panelInput = aside.querySelector('.lightpanel input')!;
    panelInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(localStorage.getItem(ONBOARDING_STORAGE_KEY)).toBe('done');
    expect(root.querySelector('.onboarding-card')).toBeNull();
  });

  it('announces a look switch through the product card heading when the rail has no label', async () => {
    const heading = document.createElement('h3');
    heading.className = 'product-card__name';
    heading.textContent = 'Wallis Dress';
    aside.appendChild(heading);
    a11y = mountA11y({ root, aside, canvas, announcer, search: '?e2e=1' });
    const liveRegion = root.querySelector('.a11y-live-region')!;

    canvas.dataset.look = 'mondrian-dress';
    await Promise.resolve();

    expect(liveRegion.textContent).toBe('Now showing: Wallis Dress');
  });

  it('announces the raw look id when no visitor-facing name exists', async () => {
    a11y = mountA11y({ root, aside, canvas, announcer, search: '?e2e=1' });
    const liveRegion = root.querySelector('.a11y-live-region')!;

    canvas.dataset.look = 'lone-look';
    await Promise.resolve();

    expect(liveRegion.textContent).toBe('Now showing: lone-look');
  });

  it('stays silent when the look attribute is removed after a switch', async () => {
    a11y = mountA11y({ root, aside, canvas, announcer, search: '?e2e=1' });
    const liveRegion = root.querySelector('.a11y-live-region')!;
    canvas.dataset.look = 'zoot-suit';
    await Promise.resolve();
    vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);
    const spokenNode = liveRegion.firstChild;
    expect(liveRegion.textContent).toBe('Now showing: Zoot Suit');

    delete canvas.dataset.look;
    await Promise.resolve();
    vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);

    expect(liveRegion.textContent).toBe('Now showing: Zoot Suit');
    expect(liveRegion.firstChild).toBe(spokenNode);
  });

  it('does not re-announce a look record whose value did not change', async () => {
    a11y = mountA11y({ root, aside, canvas, announcer, search: '?e2e=1' });
    const liveRegion = root.querySelector('.a11y-live-region')!;

    canvas.dataset.look = 'wallis-dress';
    await Promise.resolve();
    vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);
    expect(liveRegion.textContent).toBe('');

    canvas.dataset.look = 'zoot-suit';
    await Promise.resolve();
    vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);
    const spokenNode = liveRegion.firstChild;
    expect(liveRegion.textContent).toBe('Now showing: Zoot Suit');

    canvas.dataset.look = 'zoot-suit';
    await Promise.resolve();
    vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);
    expect(liveRegion.firstChild).toBe(spokenNode);
  });

  it('ignores a repeated variant record and stays silent when the variant is removed', async () => {
    a11y = mountA11y({ root, aside, canvas, announcer, search: '?e2e=1' });
    const liveRegion = root.querySelector('.a11y-live-region')!;

    canvas.dataset.variant = 'base';
    await Promise.resolve();
    vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);
    expect(liveRegion.textContent).toBe('');

    canvas.dataset.variant = 'dark';
    await Promise.resolve();
    vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);
    const spokenNode = liveRegion.firstChild;
    expect(liveRegion.textContent).toBe('Mannequin: Dark charcoal');

    delete canvas.dataset.variant;
    await Promise.resolve();
    vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);
    expect(liveRegion.textContent).toBe('Mannequin: Dark charcoal');
    expect(liveRegion.firstChild).toBe(spokenNode);
  });

  it('advances the onboarding looks step when the announced look changes', async () => {
    a11y = mountA11y({ root, aside, canvas, announcer, search: '' });
    canvas.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('pointerup'));

    canvas.dataset.look = 'zoot-suit';
    await Promise.resolve();

    expect(root.querySelector('.onboarding-card__title')?.textContent).toBe('Adjust lighting');
  });

  it('announces a rotate button that appears after mount', async () => {
    aside.querySelector('button[data-action="rotate"]')?.remove();
    a11y = mountA11y({ root, aside, canvas, announcer, search: '?e2e=1' });
    const liveRegion = root.querySelector('.a11y-live-region')!;

    const lateButton = document.createElement('button');
    lateButton.dataset.action = 'rotate';
    lateButton.setAttribute('aria-pressed', 'false');
    aside.appendChild(lateButton);
    await Promise.resolve();
    expect(liveRegion.textContent).toBe('');

    lateButton.setAttribute('aria-pressed', 'true');
    await Promise.resolve();
    expect(liveRegion.textContent).toBe('Rotate on');
  });

  it('ignores a repeated or removed rotate pressed attribute', async () => {
    a11y = mountA11y({ root, aside, canvas, announcer, search: '?e2e=1' });
    const liveRegion = root.querySelector('.a11y-live-region')!;
    const rotateBtn = aside.querySelector<HTMLButtonElement>('button[data-action="rotate"]')!;

    rotateBtn.setAttribute('aria-pressed', 'false');
    await Promise.resolve();
    vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);
    expect(liveRegion.textContent).toBe('');

    rotateBtn.setAttribute('aria-pressed', 'true');
    await Promise.resolve();
    vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);
    const spokenNode = liveRegion.firstChild;
    expect(liveRegion.textContent).toBe('Rotate on');

    rotateBtn.removeAttribute('aria-pressed');
    await Promise.resolve();
    vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);
    expect(liveRegion.textContent).toBe('Rotate on');
    expect(liveRegion.firstChild).toBe(spokenNode);
  });

  it('mounts without a music header and stays silent', () => {
    header.remove();
    a11y = mountA11y({ root, aside, canvas, announcer, search: '?e2e=1' });
    const liveRegion = root.querySelector('.a11y-live-region')!;
    expect(liveRegion.textContent).toBe('');
  });

  it('ignores a repeated or removed music pressed attribute', async () => {
    a11y = mountA11y({ root, aside, canvas, announcer, search: '?e2e=1' });
    const liveRegion = root.querySelector('.a11y-live-region')!;
    const musicBtn = header.querySelector<HTMLButtonElement>('button.music-switch')!;

    musicBtn.setAttribute('aria-pressed', 'false');
    await Promise.resolve();
    vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);
    expect(liveRegion.textContent).toBe('');

    musicBtn.setAttribute('aria-pressed', 'true');
    await Promise.resolve();
    vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);
    const spokenNode = liveRegion.firstChild;
    expect(liveRegion.textContent).toBe('Music on');

    musicBtn.removeAttribute('aria-pressed');
    await Promise.resolve();
    vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);
    expect(liveRegion.textContent).toBe('Music on');
    expect(liveRegion.firstChild).toBe(spokenNode);
  });

  it('stops every announcement channel and removes its owned surfaces on dispose', async () => {
    a11y = mountA11y({ root, aside, canvas, announcer, search: '' });
    expect(root.querySelector('.onboarding-card')).not.toBeNull();
    expect(root.querySelector('#a11y-tooltip')).not.toBeNull();
    const liveRegion = root.querySelector('.a11y-live-region')!;

    a11y.dispose();
    a11y.dispose();
    expect(root.querySelector('.onboarding-card')).toBeNull();
    expect(root.querySelector('#a11y-tooltip')).toBeNull();

    canvas.dataset.look = 'zoot-suit';
    aside.querySelector('button[data-action="rotate"]')?.setAttribute('aria-pressed', 'true');
    header.querySelector('button.music-switch')?.setAttribute('aria-pressed', 'true');
    await Promise.resolve();
    vi.advanceTimersByTime(ANNOUNCEMENT_WINDOW_MS);
    expect(liveRegion.textContent).toBe('');
  });
});
