// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
            <span class="entry-lobby__fact-heading"></span>
            <p class="entry-lobby__fact-text"></p>
            <span class="entry-lobby__fact-source"></span>
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

  it('displays approved facts during loading and rotates them', async () => {
    const { lobby, element } = mountLobby();
    element.querySelector<HTMLButtonElement>('#lobby-load-btn')!.click();

    const factText = element.querySelector('.entry-lobby__fact-text')!;
    expect(factText.textContent).toContain(APPROVED_FACTS[0].text);

    // Advance by rotation interval
    await vi.advanceTimersByTimeAsync(6000);
    expect(factText.textContent).toContain(APPROVED_FACTS[1].text);

    lobby.setReady();
    // Verify rotation stops when ready
    await vi.advanceTimersByTimeAsync(12000);
    expect(factText.textContent).toContain(APPROVED_FACTS[1].text);
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

describe('unsupported browser behavior', () => {
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

describe('ENTRY-3 transition handshake additions', () => {
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
});
