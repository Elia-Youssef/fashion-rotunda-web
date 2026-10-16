import { afterEach, beforeEach, vi } from 'vitest';
import { APPROVED_FACTS, mountEntryLobby } from '../../src/ui/entry-lobby';
import type { EntryLobby } from '../../src/ui/entry-lobby';

// The shared harness of the entry lobby suites. installLobbyHarness() installs the per-test
// hooks every mounting suite needs: a fake clock, a fresh document root and a clean fake
// storage, and the disposal of every lobby mounted through mountLobby(). The hooks reassign
// root and store per test; a suite that touches them directly imports those live bindings
// and always sees the current test's instances.

export class FakeStorage {
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

export let root: HTMLElement;
export let store: FakeStorage;
const mountedLobbies: EntryLobby[] = [];

export function mountLobby(options: {
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

export function installLobbyHarness(): void {
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
}
