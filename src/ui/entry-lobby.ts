// Opaque Entry Lobby and Deferred Experience Boot.
// Replaces the translucent loading gate with an opaque branded lobby.
// Owns the branded lobby, state machine, focus trap, truthful progress,
// audio preference contract, and deferred boot trigger.
// Does NOT import renderer, scene, camera, material, lighting, or post-processing modules.
// The markup and the progress tracker live in entry-lobby/markup and entry-lobby/progress,
// re-exported here, so this module stays the single import point for the lobby.

import './entry-lobby.css';

import { resolveMusicPreference, storeMusicPreference } from '../audio/preference';
import type { KeyValueStore } from '../audio/preference';
import { formatProgress, progressRatio } from '../loading/progress';
import { skySourceFromSearch } from '../lighting/sky';
import { buildLobbyMarkup } from './entry-lobby/markup';
import { trackFirstFrameProgress } from './entry-lobby/progress';
import type { ProgressReading } from './entry-lobby/progress';

export type LobbyState =
  | 'idle'
  | 'loading'
  | 'ready-hidden'
  | 'cover-to-black'
  | 'black-hold'
  | 'revealing'
  | 'revealed'
  | 'error'
  | 'disposed';

export { trackFirstFrameProgress };
export type { ProgressReading };

export interface EntryLobbyOptions {
  /** Where to find or mount the lobby. Default: document.body */
  root?: HTMLElement;
  /** URL search parameters string, e.g. location.search */
  search: string;
  /** Storage for music preference. Default: window.localStorage */
  store?: KeyValueStore | null;
  /** Initial unsupported message if WebGPU/WebGL2 are missing */
  unsupportedMessage?: string | null;
  /** Random source for the visit's fact choice. Default: Math.random, values in [0, 1). */
  random?: () => number;
}

export interface EntryLobby {
  readonly state: LobbyState;
  readonly element: HTMLElement;
  waitForLoadRequest(): Promise<{ musicPreference: 'on' | 'off' }>;
  trackProgress(contentBase: string): () => void;
  setProgress(reading: ProgressReading): void;
  setReady(): void;
  setCoverToBlack(): void;
  setBlackHold(): void;
  setRevealing(): void;
  setRevealed(): void;
  setError(message: string): void;
  setUnsupported(message: string): void;
  waitUntilReadyHidden(): Promise<void>;
  prepareForReveal(): void;
  dispose(): void;
}

export const APPROVED_FACTS: Array<{ heading: string; text: string }> = [
  {
    heading: 'ARCHITECTURAL & GRAPHICS PROVENANCE',
    text: 'Built on WebGPU for next-generation hardware rasterization, with seamless automatic fallback to WebGL 2.',
  },
  {
    heading: 'SPATIAL GEOMETRY RECONSTRUCTION',
    text: 'Architectural rotunda, dome framing, and interior surfaces reconstructed from original Unreal Engine assets.',
  },
  {
    heading: 'ASSET & TEXTURE OPTIMIZATION',
    text: 'High-efficiency asset streaming utilizing glTF 2.0 binary geometry and KTX2 supercompressed GPU textures.',
  },
  {
    heading: 'ADAPTIVE QUALITY TIERING',
    text: 'Automated hardware capability profiling allocating dynamic quality tiers for shadows, resolution, and post-processing.',
  },
  {
    heading: 'ACCESSIBLE DOM OVERLAY',
    text: 'Semantic, accessible HTML/CSS interface layer decoupled from the 3D canvas, guaranteeing full keyboard navigation.',
  },
  {
    heading: 'CURATORIAL LIGHTING RIG',
    text: 'Tri-point studio lighting rig combined with architectural daylight dome illumination.',
  },
];

/**
 * Evaluates query parameter precedence for showing the entry lobby:
 * - gate=on explicitly shows the lobby, including when e2e=1.
 * - gate=off explicitly bypasses the lobby and starts loading immediately.
 * - absent gate plus e2e=1 preserves existing direct-load test behavior.
 * - ordinary visitor URLs show the lobby.
 */
export function lobbyWanted(search: string): boolean {
  const params = new URLSearchParams(search);
  const gate = params.get('gate');
  if (gate === 'on') {
    return true;
  }
  if (gate === 'off') {
    return false;
  }
  if (params.get('e2e') === '1') {
    return false;
  }
  return true;
}

/** Fallback helper to safely read window.localStorage */
function safeLocalStorage(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function mountEntryLobby(options: EntryLobbyOptions): EntryLobby {
  const doc = options.root?.ownerDocument ?? document;
  const root = options.root ?? doc.body;
  const store = options.store !== undefined ? options.store : safeLocalStorage();

  let lobbyElement = root.querySelector<HTMLElement>('#entry-lobby');
  const isHydrating = lobbyElement !== null;

  if (lobbyElement === null) {
    lobbyElement = buildLobbyMarkup(doc);
    root.appendChild(lobbyElement);
  }

  const lobby = lobbyElement;

  const loadBtn = lobby.querySelector<HTMLButtonElement>('#lobby-load-btn');
  const musicSwitchBtn = lobby.querySelector<HTMLButtonElement>('.entry-lobby__music-switch');
  const musicLabel = musicSwitchBtn?.querySelector<HTMLElement>('.music-switch__label') ?? null;
  const idlePane = lobby.querySelector<HTMLElement>('.entry-lobby__idle-pane');
  const loadingPane = lobby.querySelector<HTMLElement>('.entry-lobby__loading-pane');
  const errorPane = lobby.querySelector<HTMLElement>('.entry-lobby__error-pane');
  const cardElement = lobby.querySelector<HTMLElement>('.entry-lobby__card');
  const progressBar = lobby.querySelector<HTMLProgressElement>('.entry-lobby__progress-bar');
  const statusElement = lobby.querySelector<HTMLElement>('.entry-lobby__status');
  const readoutElement = lobby.querySelector<HTMLElement>('.entry-lobby__progress-readout');
  const factHeading = lobby.querySelector<HTMLElement>('.entry-lobby__fact-heading');
  const factText = lobby.querySelector<HTMLElement>('.entry-lobby__fact-text');
  const retryBtn = lobby.querySelector<HTMLButtonElement>('#lobby-retry-btn');
  const errorMessage = lobby.querySelector<HTMLElement>('.entry-lobby__error-message');

  let currentState: LobbyState = 'idle';
  lobby.dataset['state'] = currentState;

  // Music preference state resolution
  let currentMusicPreference = resolveMusicPreference(options.search, store);

  function syncMusicSwitchUI(): void {
    if (musicSwitchBtn === null) {
      return;
    }
    const isPlaying = currentMusicPreference === 'on';
    musicSwitchBtn.dataset['music'] = isPlaying ? 'armed' : 'off';
    musicSwitchBtn.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
    if (musicLabel !== null) {
      musicLabel.textContent = isPlaying ? 'Music on' : 'Music off';
    }
  }
  syncMusicSwitchUI();

  /**
   * The unsupported surface, shared by the mount-time knowledge (no API even exists) and the
   * post-press knowledge (no backend can start): the error pane becomes a support explanation
   * with no retry, because reloading cannot create support the browser lacks.
   */
  function applyUnsupportedSurface(message: string): void {
    if (loadBtn !== null) {
      loadBtn.disabled = true;
    }
    if (errorMessage !== null) {
      errorMessage.id = 'lobby-unsupported-message';
      errorMessage.textContent = message;
      loadBtn?.setAttribute('aria-describedby', errorMessage.id);
    }
    if (errorPane !== null) {
      errorPane.setAttribute('role', 'alert');
      errorPane.hidden = false;
      const errorTitle = errorPane.querySelector<HTMLElement>('.entry-lobby__error-title');
      if (errorTitle !== null) {
        errorTitle.textContent = '3D unavailable';
      }
    }
    if (retryBtn !== null) {
      retryBtn.hidden = true;
    }
  }

  // Unsupported browser mode handling
  if (options.unsupportedMessage) {
    applyUnsupportedSurface(options.unsupportedMessage);
  }

  // Load request promise resolver
  let loadRequestResolver: ((result: { musicPreference: 'on' | 'off' }) => void) | null = null;
  const loadRequestPromise = new Promise<{ musicPreference: 'on' | 'off' }>((resolve) => {
    loadRequestResolver = resolve;
  });

  // Ready-hidden promise resolver
  let readyHiddenResolver: (() => void) | null = null;
  const readyHiddenPromise = new Promise<void>((resolve) => {
    readyHiddenResolver = resolve;
  });

  let stopProgressTrackingFn: (() => void) | null = null;

  // Choose and render once at mount, before any loading or progress transitions.
  const random = options.random ?? Math.random;
  const fact = APPROVED_FACTS[Math.floor(random() * APPROVED_FACTS.length)];
  function renderFact(): void {
    if (factHeading !== null) {
      factHeading.textContent = fact.heading;
    }
    if (factText !== null) {
      factText.textContent = `"${fact.text}"`;
    }
  }

  renderFact();

  const listeners = new AbortController();
  // Global focus containment belongs to the modal input phase, which ends at reveal.
  const inputListeners = new AbortController();

  // Toggle music preference before Load Experience
  if (musicSwitchBtn !== null) {
    musicSwitchBtn.addEventListener(
      'click',
      () => {
        currentMusicPreference = currentMusicPreference === 'on' ? 'off' : 'on';
        storeMusicPreference(store, currentMusicPreference);
        syncMusicSwitchUI();
      },
      { signal: listeners.signal },
    );
  }

  function triggerLoadExperience(): void {
    if (currentState !== 'idle' || loadBtn?.disabled) {
      return;
    }
    currentState = 'loading';
    lobby.dataset['state'] = currentState;

    if (loadBtn !== null) {
      loadBtn.disabled = true;
      loadBtn.setAttribute('aria-busy', 'true');
    }

    if (idlePane !== null) {
      idlePane.hidden = true;
    }
    if (loadingPane !== null) {
      loadingPane.hidden = false;
    }
    if (cardElement !== null) {
      cardElement.dataset['view'] = 'loading';
    }

    if (loadRequestResolver !== null) {
      loadRequestResolver({ musicPreference: currentMusicPreference });
      loadRequestResolver = null;
    }
  }

  // Bind load button
  if (loadBtn !== null) {
    loadBtn.addEventListener(
      'click',
      (e) => {
        e.preventDefault();
        triggerLoadExperience();
      },
      { signal: listeners.signal },
    );

    loadBtn.addEventListener(
      'keydown',
      (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          triggerLoadExperience();
        }
      },
      { signal: listeners.signal },
    );
  }

  // Bind retry button
  if (retryBtn !== null) {
    retryBtn.addEventListener(
      'click',
      () => {
        window.location.reload();
      },
      { signal: listeners.signal },
    );
  }

  // Keyboard accessibility: focus trapping & Tab containment
  doc.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      if (currentState === 'disposed') {
        return;
      }
      if (event.key === 'Escape') {
        // Escape must NOT dismiss the lobby into an unloaded scene
        event.preventDefault();
        return;
      }

      if (event.key === 'Tab') {
        const focusables = Array.from(
          lobby.querySelectorAll<HTMLElement>(
            'button:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => el.offsetParent !== null || el === doc.activeElement);

        if (focusables.length === 0) {
          event.preventDefault();
          return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];

        if (event.shiftKey && doc.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && doc.activeElement === last) {
          event.preventDefault();
          first.focus();
        } else if (!focusables.includes(doc.activeElement as HTMLElement)) {
          event.preventDefault();
          first.focus();
        }
      }
    },
    { signal: inputListeners.signal },
  );

  // Set initial focus intentionally
  if (!isHydrating || doc.activeElement === doc.body || doc.activeElement === null) {
    lobby.tabIndex = -1;
    if (loadBtn && !loadBtn.disabled) {
      loadBtn.focus();
    } else {
      lobby.focus();
    }
  }

  const lobbyHandle: EntryLobby = {
    get state(): LobbyState {
      return currentState;
    },

    get element(): HTMLElement {
      return lobby;
    },

    waitForLoadRequest(): Promise<{ musicPreference: 'on' | 'off' }> {
      if (currentState !== 'idle') {
        return Promise.resolve({ musicPreference: currentMusicPreference });
      }
      return loadRequestPromise;
    },

    trackProgress(contentBase: string): () => void {
      if (stopProgressTrackingFn !== null) {
        stopProgressTrackingFn();
      }
      stopProgressTrackingFn = trackFirstFrameProgress(
        contentBase,
        (reading) => {
          lobbyHandle.setProgress(reading);
        },
        skySourceFromSearch(options.search) === 'hdr',
      );
      return () => {
        if (stopProgressTrackingFn !== null) {
          stopProgressTrackingFn();
          stopProgressTrackingFn = null;
        }
      };
    },

    setProgress(reading: ProgressReading): void {
      if (currentState !== 'loading') {
        return;
      }
      const complete = reading.totalFiles > 0 && reading.ended >= reading.totalFiles;
      if (progressBar !== null) {
        progressBar.value = complete ? 1 : reading.expected > 0 ? progressRatio(reading.received, reading.expected) : 0;
      }
      if (readoutElement !== null) {
        readoutElement.textContent = formatProgress(
          complete && !reading.fromCache ? reading.expected : reading.received,
          reading.expected,
        );
      }
      if (statusElement !== null) {
        const base = reading.fromCache ? 'Loading from cache' : 'Loading your experience';
        statusElement.textContent =
          reading.totalFiles === 0 ? base : `${base} - ${reading.ended} of ${reading.totalFiles} files`;
      }
    },

    setReady(): void {
      // 'error' is terminal: a ready that arrives after a failure must not take the pane away.
      if (currentState === 'disposed' || currentState === 'error') {
        return;
      }
      if (stopProgressTrackingFn !== null) {
        stopProgressTrackingFn();
        stopProgressTrackingFn = null;
      }
      currentState = 'ready-hidden';
      lobby.dataset['state'] = currentState;

      if (statusElement !== null) {
        statusElement.textContent = 'Experience ready';
      }
      if (progressBar !== null) {
        progressBar.value = 1;
      }

      if (readyHiddenResolver !== null) {
        readyHiddenResolver();
        readyHiddenResolver = null;
      }
    },

    setCoverToBlack(): void {
      if (currentState === 'disposed' || currentState === 'error') {
        return;
      }
      currentState = 'cover-to-black';
      lobby.dataset['state'] = currentState;
    },

    setBlackHold(): void {
      if (currentState === 'disposed' || currentState === 'error') {
        return;
      }
      currentState = 'black-hold';
      lobby.dataset['state'] = currentState;
    },

    setRevealing(): void {
      if (currentState === 'disposed' || currentState === 'error') {
        return;
      }
      currentState = 'revealing';
      lobby.dataset['state'] = currentState;
    },

    setRevealed(): void {
      if (currentState === 'disposed') {
        return;
      }
      inputListeners.abort();
      currentState = 'revealed';
      lobby.dataset['state'] = currentState;
      lobby.setAttribute('inert', '');
      lobby.setAttribute('aria-hidden', 'true');
      lobby.hidden = true;
      lobby.style.display = 'none';
      lobby.style.pointerEvents = 'none';
    },

    setError(message: string): void {
      if (currentState === 'disposed') {
        return;
      }
      if (stopProgressTrackingFn !== null) {
        stopProgressTrackingFn();
        stopProgressTrackingFn = null;
      }
      currentState = 'error';
      lobby.dataset['state'] = currentState;

      if (idlePane !== null) {
        idlePane.hidden = true;
      }
      if (loadingPane !== null) {
        loadingPane.hidden = true;
      }
      if (errorPane !== null) {
        errorPane.hidden = false;
      }
      if (cardElement !== null) {
        cardElement.dataset['view'] = 'error';
      }
      if (errorMessage !== null) {
        errorMessage.textContent = message;
      }
      if (retryBtn !== null) {
        retryBtn.focus();
      }
    },

    setUnsupported(message: string): void {
      if (currentState === 'disposed') {
        return;
      }
      if (stopProgressTrackingFn !== null) {
        stopProgressTrackingFn();
        stopProgressTrackingFn = null;
      }
      currentState = 'error';
      lobby.dataset['state'] = currentState;

      if (idlePane !== null) {
        idlePane.hidden = true;
      }
      if (loadingPane !== null) {
        loadingPane.hidden = true;
      }
      if (cardElement !== null) {
        cardElement.dataset['view'] = 'error';
      }
      applyUnsupportedSurface(message);
      // The retry is gone and Load is disabled, so the dialog itself takes focus and the alert
      // is what a screen reader lands on.
      lobby.tabIndex = -1;
      lobby.focus();
    },

    waitUntilReadyHidden(): Promise<void> {
      if (currentState === 'ready-hidden') {
        return Promise.resolve();
      }
      return readyHiddenPromise;
    },

    prepareForReveal(): void {
      // The scene reveal keeps the lobby hit-testable through cover-to-black. The black veil assumes
      // ownership only after the lobby has visibly reached its opaque black state.
    },

    dispose(): void {
      if (stopProgressTrackingFn !== null) {
        stopProgressTrackingFn();
        stopProgressTrackingFn = null;
      }
      inputListeners.abort();
      listeners.abort();
      currentState = 'disposed';
      lobby.remove();
    },
  };

  return lobbyHandle;
}
