// Opaque Entry Lobby and Deferred Experience Boot.
// Replaces the translucent loading gate with an opaque branded lobby.
// Owns the branded lobby, state machine, truthful progress and deferred boot trigger.
// Does NOT import renderer, scene, camera, material or post-processing modules; its one lighting
// import is skySourceFromSearch from lighting/sky.
// Gate precedence, the music preference switch and focus handling live in entry-lobby/gate,
// entry-lobby/music-switch and entry-lobby/focus-trap. This facade keeps their public contract.
// The markup builder lives in entry-lobby/markup; the progress tracker in entry-lobby/progress
// and the gate decision are re-exported here. Page code imports the lobby through this module alone.

import './entry-lobby.css';

import type { KeyValueStore } from '../audio/preference';
import { formatProgress, progressRatio } from '../loading/progress';
import { skySourceFromSearch } from '../lighting/sky';
import { bindFocusTrap, focusInitially } from './entry-lobby/focus-trap';
import { buildLobbyMarkup } from './entry-lobby/markup';
import { createLobbyMusicSwitch } from './entry-lobby/music-switch';
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
export { lobbyWanted } from './entry-lobby/gate';

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
  /**
   * Starts truthful first-frame progress tracking. `wantedLook` is the raw ?look= value (or
   * null), so the expected bytes and file count follow the look the catalogue's one look rule
   * resolves from it, not always the catalogue's first look.
   */
  trackProgress(contentBase: string, wantedLook?: string | null): () => void;
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
  const errorTitle = lobby.querySelector<HTMLElement>('.entry-lobby__error-title');

  let currentState: LobbyState = 'idle';

  /**
   * The one transition every state change goes through. The load button's aria-busy is
   * derived from the state alone: present while the load it names is in progress, removed
   * by whatever ends that load, so the attribute never outlives the state it describes.
   */
  function transitionTo(next: LobbyState): void {
    currentState = next;
    lobby.dataset['state'] = next;
    if (next === 'loading') {
      loadBtn?.setAttribute('aria-busy', 'true');
    } else {
      loadBtn?.removeAttribute('aria-busy');
    }
  }

  transitionTo('idle');

  const listeners = new AbortController();
  const musicSwitch = createLobbyMusicSwitch(musicSwitchBtn, options.search, store, listeners.signal);

  /**
   * The error pane's one announcement path, shared by the load failure and the unsupported
   * surface. The title and message are written while the pane is still hidden, because a
   * live region announces only the changes that happen while it is rendered, and the pane
   * then appears with its alert role: one announcement per error, the same on every path.
   */
  function showErrorPane(message: string, title: string | null): void {
    if (title !== null && errorTitle !== null) {
      errorTitle.textContent = title;
    }
    if (errorMessage !== null) {
      errorMessage.textContent = message;
    }
    if (errorPane !== null) {
      errorPane.setAttribute('role', 'alert');
      errorPane.hidden = false;
    }
  }

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
      loadBtn?.setAttribute('aria-describedby', errorMessage.id);
    }
    showErrorPane(message, '3D unavailable');
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

  // Global focus containment belongs to the modal input phase, which ends at reveal.
  const inputListeners = new AbortController();

  function triggerLoadExperience(): void {
    if (currentState !== 'idle' || loadBtn?.disabled) {
      return;
    }
    transitionTo('loading');

    // The press is one-shot: Load stays disabled for the lobby's remaining life. Only
    // aria-busy tracks the load itself, and transitionTo clears it when the load ends.
    if (loadBtn !== null) {
      loadBtn.disabled = true;
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
      loadRequestResolver({ musicPreference: musicSwitch.preference });
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

  bindFocusTrap(doc, lobby, inputListeners.signal, () => currentState === 'disposed');
  focusInitially(doc, lobby, loadBtn, isHydrating);

  const lobbyHandle: EntryLobby = {
    get state(): LobbyState {
      return currentState;
    },

    get element(): HTMLElement {
      return lobby;
    },

    waitForLoadRequest(): Promise<{ musicPreference: 'on' | 'off' }> {
      if (currentState !== 'idle') {
        return Promise.resolve({ musicPreference: musicSwitch.preference });
      }
      return loadRequestPromise;
    },

    trackProgress(contentBase: string, wantedLook?: string | null): () => void {
      if (stopProgressTrackingFn !== null) {
        stopProgressTrackingFn();
      }
      stopProgressTrackingFn = trackFirstFrameProgress(
        contentBase,
        (reading) => {
          lobbyHandle.setProgress(reading);
        },
        skySourceFromSearch(options.search) === 'hdr',
        wantedLook ?? null,
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
      transitionTo('ready-hidden');

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
      transitionTo('cover-to-black');
    },

    setBlackHold(): void {
      if (currentState === 'disposed' || currentState === 'error') {
        return;
      }
      transitionTo('black-hold');
    },

    setRevealing(): void {
      if (currentState === 'disposed' || currentState === 'error') {
        return;
      }
      transitionTo('revealing');
    },

    setRevealed(): void {
      if (currentState === 'disposed') {
        return;
      }
      if (stopProgressTrackingFn !== null) {
        stopProgressTrackingFn();
        stopProgressTrackingFn = null;
      }
      inputListeners.abort();
      listeners.abort();
      transitionTo('revealed');
      lobby.setAttribute('inert', '');
      lobby.setAttribute('aria-hidden', 'true');
      lobby.hidden = true;
      lobby.style.display = 'none';
      lobby.style.pointerEvents = 'none';
      // Keep the revealed state readable for later startup-failure routing.
      lobby.remove();
    },

    setError(message: string): void {
      if (currentState === 'disposed') {
        return;
      }
      if (stopProgressTrackingFn !== null) {
        stopProgressTrackingFn();
        stopProgressTrackingFn = null;
      }
      transitionTo('error');

      if (idlePane !== null) {
        idlePane.hidden = true;
      }
      if (loadingPane !== null) {
        loadingPane.hidden = true;
      }
      showErrorPane(message, null);
      if (cardElement !== null) {
        cardElement.dataset['view'] = 'error';
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
      transitionTo('error');

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
      transitionTo('disposed');
      lobby.remove();
    },
  };

  return lobbyHandle;
}
