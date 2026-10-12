// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { contentUrl, loadCatalog } from '../../src/catalog/catalog';
import type { Catalog } from '../../src/catalog/catalog';

import {
  APPROVED_FACTS,
  lobbyWanted,
  mountEntryLobby,
  trackFirstFrameProgress,
} from '../../src/ui/entry-lobby';
import type { EntryLobby, ProgressReading } from '../../src/ui/entry-lobby';

class FakeStorage {
  private data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  clear(): void {
    this.data.clear();
  }
}

let root: HTMLElement;
let store: FakeStorage;
const mountedLobbies: EntryLobby[] = [];

function mountLobby(options: {
  search?: string;
  unsupportedMessage?: string | null;
  withPreExistingDOM?: boolean;
  random?: () => number;
} = {}): { lobby: EntryLobby; element: HTMLElement } {
  if (options.withPreExistingDOM) {
    const existing = document.createElement('div');
    existing.id = 'entry-lobby';
    existing.className = 'entry-lobby';
    existing.dataset.state = 'idle';
    existing.innerHTML = `
      <div class="entry-lobby__card">
        <div class="entry-lobby__idle-pane">
          <button type="button" class="entry-lobby__load-btn" id="lobby-load-btn">LOAD EXPERIENCE</button>
        </div>
        <div class="entry-lobby__loading-pane" hidden>
          <progress class="entry-lobby__progress-bar" max="1" value="0"></progress>
          <p class="entry-lobby__status" aria-live="polite">Loading your experience</p>
          <p class="entry-lobby__progress-readout">0.0 MB of 0.0 MB</p>
          <div class="entry-lobby__fact-container">
            <span class="entry-lobby__fact-heading">${APPROVED_FACTS[0].heading}</span>
            <p class="entry-lobby__fact-text">"${APPROVED_FACTS[0].text}"</p>
          </div>
        </div>
        <div class="entry-lobby__error-pane" hidden>
          <p class="entry-lobby__error-message"></p>
          <button type="button" class="entry-lobby__retry-btn" id="lobby-retry-btn">RETRY LOADING</button>
        </div>
      </div>
      <button type="button" class="entry-lobby__music-switch music-switch" data-music="armed" aria-pressed="true">
        <span class="music-switch__label">Music on</span>
      </button>
    `;
    root.appendChild(existing);
  }

  const lobby = mountEntryLobby({
    root,
    search: options.search ?? '',
    store,
    unsupportedMessage: options.unsupportedMessage ?? null,
    ...(options.random === undefined ? {} : { random: options.random }),
  });
  mountedLobbies.push(lobby);

  const element = root.querySelector<HTMLElement>('#entry-lobby');
  if (element === null) {
    throw new Error('entry-lobby element not found');
  }
  return { lobby, element };
}

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.appendChild(root);
  store = new FakeStorage();
});

afterEach(() => {
  mountedLobbies.splice(0).forEach((l) => l.dispose());
  vi.restoreAllMocks();
  vi.useRealTimers();
  root.remove();
  document.body.innerHTML = '';
});

describe('lobbyWanted precedence', () => {
  it('shows the lobby for standard visitor URLs', () => {
    expect(lobbyWanted('')).toBe(true);
    expect(lobbyWanted('?webgl=1')).toBe(true);
    expect(lobbyWanted('?look=first')).toBe(true);
  });

  it('explicitly shows the lobby when gate=on, even if e2e=1', () => {
    expect(lobbyWanted('?gate=on')).toBe(true);
    expect(lobbyWanted('?e2e=1&gate=on')).toBe(true);
    expect(lobbyWanted('?gate=on&e2e=1')).toBe(true);
    expect(lobbyWanted('?e2e=1&gate=on&music=off')).toBe(true);
  });

  it('bypasses the lobby when gate=off', () => {
    expect(lobbyWanted('?gate=off')).toBe(false);
    expect(lobbyWanted('?gate=off&e2e=1')).toBe(false);
    expect(lobbyWanted('?e2e=1&gate=off')).toBe(false);
  });

  it('bypasses the lobby for automated direct-load tests when e2e=1 and gate is absent', () => {
    expect(lobbyWanted('?e2e=1')).toBe(false);
    expect(lobbyWanted('?webgl=1&e2e=1')).toBe(false);
    expect(lobbyWanted('?e2e=1&music=off')).toBe(false);
  });
});

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

describe('Music preference contract in lobby', () => {
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

describe('loading state and truthful progress', () => {
  it('updates progress bar, byte readout, and status faithfully', () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
    expect(lobby.state).toBe('loading');

    const reading: ProgressReading = {
      received: 5_000_000,
      expected: 10_000_000,
      ended: 2,
      totalFiles: 4,
      fromCache: false,
    };
    lobby.setProgress(reading);

    const bar = element.querySelector<HTMLProgressElement>('.entry-lobby__progress-bar')!;
    expect(bar.value).toBe(0.5);
    expect(element.querySelector('.entry-lobby__progress-readout')?.textContent).toBe(
      '5.0 MB of 10.0 MB',
    );
    expect(element.querySelector('.entry-lobby__status')?.textContent).toBe(
      'Loading your experience - 2 of 4 files',
    );
  });

  it('reports cache hits truthfully', () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();

    lobby.setProgress({
      received: 0,
      expected: 10_000_000,
      ended: 4,
      totalFiles: 4,
      fromCache: true,
    });

    expect(element.querySelector('.entry-lobby__status')?.textContent).toBe(
      'Loading from cache - 4 of 4 files',
    );
  });
});

describe.each([false, true])('one fact per visit (hydration=%s)', (withPreExistingDOM) => {
  function expectFact(element: HTMLElement, index: number): void {
    expect(element.querySelector('.entry-lobby__fact-heading')?.textContent)
      .toBe(APPROVED_FACTS[index].heading);
    expect(element.querySelector('.entry-lobby__fact-text')?.textContent)
      .toBe(`"${APPROVED_FACTS[index].text}"`);
  }

  it.each([
    { value: 0, index: 0 },
    { value: 0.1, index: 0 },
    { value: 0.5, index: 3 },
    { value: 1 - Number.EPSILON, index: 5 },
  ])('selects fact $index at mount from random value $value', ({ value, index }) => {
    const random = vi.fn(() => value);
    const { element } = mountLobby({ withPreExistingDOM, random });
    expectFact(element, index);
    expect(random).toHaveBeenCalledOnce();
  });

  it('defaults to Math.random when no source is injected', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const { element } = mountLobby({ withPreExistingDOM });
    expectFact(element, 3);
    expect(random).toHaveBeenCalledOnce();
  });

  // Five former rotation periods exercise long idle, loading and error waits.
  const longWaitMs = 30_000;

  it.each([false, true])('keeps the mounted fact through loading and error (reduced motion=%s)',
    async (reducedMotion) => {
      vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reducedMotion })));
      try {
        const random = vi.fn(() => 0.5);
        const { lobby, element } = mountLobby({ withPreExistingDOM, random });
        expectFact(element, 3);
        await vi.advanceTimersByTimeAsync(longWaitMs);
        expectFact(element, 3);

        element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
        expectFact(element, 3);
        await vi.advanceTimersByTimeAsync(longWaitMs);
        expectFact(element, 3);

        for (const fromCache of [false, true]) {
          lobby.setProgress({ received: 5, expected: 10, ended: 1, totalFiles: 2, fromCache });
          expectFact(element, 3);
          await vi.advanceTimersByTimeAsync(longWaitMs);
          expectFact(element, 3);
        }

        lobby.setError('Connection lost');
        expectFact(element, 3);
        await vi.advanceTimersByTimeAsync(longWaitMs);
        expectFact(element, 3);
        expect(random).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllGlobals();
      }
    });

  it.each([false, true])('leaves no fact timer pending (reduced motion=%s)', async (reducedMotion) => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reducedMotion })));
    try {
      const { lobby, element } = mountLobby({ withPreExistingDOM, random: () => 0 });
      // Drain jsdom's deferred document work before inspecting pending display timers.
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();
      expect(vi.getTimerCount()).toBe(0);
      lobby.setError('Connection lost');
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
      lobby.dispose();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

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

describe('first-frame byte total and the sky source', () => {
  // The shipped catalog and manifest, served through a stubbed fetch, so the totals below are the
  // real first-frame files of the full set. jsdom's URL is not the one node:fs accepts, hence paths.
  const contentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/content');
  const catalogText = readFileSync(path.join(contentDir, 'catalog.json'), 'utf8');
  const manifestText = readFileSync(path.join(contentDir, 'manifest.json'), 'utf8');
  const catalog = JSON.parse(catalogText) as {
    environment: { file: string };
    rotunda: { file: string };
    plinth: { file: string };
    looks: { file: string }[];
  };
  const manifest = JSON.parse(manifestText) as {
    sets: { full: { files: Record<string, { bytes: number }> } };
  };
  const bytes = (file: string): number => manifest.sets.full.files[file].bytes;
  const withoutEnvironment =
    bytes(catalog.rotunda.file) + bytes(catalog.plinth.file) + bytes(catalog.looks[0].file);

  async function firstReading(countEnvironment: boolean | undefined): Promise<ProgressReading> {
    vi.stubGlobal('fetch', (url: string) =>
      Promise.resolve(new Response(url.endsWith('manifest.json') ? manifestText : catalogText)),
    );
    const readings: ProgressReading[] = [];
    let stop: (() => void) | null = null;
    try {
      stop =
        countEnvironment === undefined
          ? trackFirstFrameProgress('/content', (reading) => readings.push(reading))
          : trackFirstFrameProgress('/content', (reading) => readings.push(reading), countEnvironment);
      await vi.waitFor(() => {
        expect(readings.some((reading) => reading.expected > 0)).toBe(true);
      });
    } finally {
      stop?.();
      vi.unstubAllGlobals();
    }
    return readings.find((reading) => reading.expected > 0)!;
  }

  it('waits for no environment bytes by default: the procedural sky is not fetched', async () => {
    const reading = await firstReading(undefined);
    expect(reading.expected).toBe(withoutEnvironment);
    expect(reading.totalFiles).toBe(3);
  });

  it('counts the HDR only under the ?sky=hdr diagnostic', async () => {
    const reading = await firstReading(true);
    expect(reading.expected).toBe(withoutEnvironment + bytes(catalog.environment.file));
    expect(reading.totalFiles).toBe(4);
  });

  it.each([
    [false, false, false], [false, false, true],
    [true, false, false], [true, false, true],
    [true, true, false], [true, true, true],
  ])('shares tracker requests with content selection (half=%s, missing=%s, hdr=%s)',
    async (half, missing, hdr) => {
      // Execute the content-set selection itself, including the half-to-full failure fallback.
      const main = ts.createSourceFile('main.ts', readFileSync('src/main.ts', 'utf8'), ts.ScriptTarget.Latest, true);
      const fn = main.statements.find((node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'loadContentSet');
      if (fn === undefined) throw new Error('missing content-set selection');
      const code = ts.transpileModule(fn.getText(main), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const select = new Function('loadCatalog', 'contentUrl', `
        const FULL_CONTENT_BASE = '/content', HALF_CONTENT_BASE = '/content/half';
        ${code} return loadContentSet;
      `)(loadCatalog, contentUrl) as (half: boolean) => Promise<{ base: string; catalog: Catalog }>;
      let resolve!: (response: Response) => void;
      const full = new Promise<Response>((yes) => { resolve = yes; });
      const fetchFn = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/content/catalog.json') return full;
        if (url === '/content/manifest.json') return Promise.resolve(new Response(manifestText));
        if (url === '/content/half/catalog.json') return Promise.resolve(
          new Response(missing ? 'missing' : catalogText, { status: missing ? 404 : 200 }),
        );
        throw new Error('unexpected request: ' + url);
      });
      vi.stubGlobal('fetch', fetchFn);
      // The extra HDR and nonselected look must never enter the default progress list.
      const entries = [
        { name: '/content/' + catalog.rotunda.file, transferSize: 101 },
        { name: '/content/' + catalog.plinth.file, transferSize: 202 },
        { name: '/content/' + catalog.looks[0].file, transferSize: 303 },
        { name: '/content/' + catalog.environment.file, transferSize: 404 },
        { name: '/content/looks/not-first.glb', transferSize: 999 },
      ].map((entry) => ({ ...entry, responseEnd: 1, entryType: 'resource' }));
      vi.stubGlobal('performance', { getEntriesByType: () => entries });
      const readings: ProgressReading[] = [];
      let stop: (() => void) | undefined;
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(fetchFn).not.toHaveBeenCalled();
        stop = trackFirstFrameProgress('/content', (reading) => readings.push(reading), hdr);
        const selected = select(half);
        resolve(new Response(catalogText));
        expect((await selected).base).toBe(half && !missing ? '/content/half' : '/content');
        await vi.waitFor(() => expect(readings.some((reading) => reading.expected > 0)).toBe(true));
        // A later consumer also reuses the settled request.
        await select(half);
        const reading = readings.find((one) => one.expected > 0)!;
        expect(reading).toEqual({ received: hdr ? 1010 : 606,
          expected: withoutEnvironment + (hdr ? bytes(catalog.environment.file) : 0),
          ended: hdr ? 4 : 3, totalFiles: hdr ? 4 : 3, fromCache: false });
        expect(fetchFn.mock.calls.map(([url]) => String(url))).toEqual([
          '/content/manifest.json', '/content/catalog.json', ...(half ? ['/content/half/catalog.json'] : []),
        ]);
        if (missing) expect(warning).toHaveBeenCalledWith(
          '[archviz] no content set at /content/half, using /content', expect.any(Error),
        );
      } finally {
        stop?.(); warning.mockRestore(); vi.unstubAllGlobals();
      }
    },
  );
});
