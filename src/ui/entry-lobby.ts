// Opaque Entry Lobby and Deferred Experience Boot.
// Replaces the translucent loading gate with an opaque branded lobby.
// Owns the branded lobby, state machine, focus trap, truthful progress,
// audio preference contract, and deferred boot trigger.
// Does NOT import renderer, scene, camera, material, lighting, or post-processing modules.

import './entry-lobby.css';

import { resolveMusicPreference, storeMusicPreference } from '../audio/preference';
import type { KeyValueStore } from '../audio/preference';
import { contentUrl, loadCatalog } from '../catalog/catalog';
import { expectedBytes, formatProgress, progressRatio, receivedBytes } from '../loading/progress';
import { skySourceFromSearch } from '../lighting/sky';
import type { ManifestFile, ResourceEntry } from '../loading/progress';

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

export interface ProgressReading {
  received: number;
  expected: number;
  ended: number;
  totalFiles: number;
  fromCache: boolean;
}

export interface EntryLobbyOptions {
  /** Where to find or mount the lobby. Default: document.body */
  root?: HTMLElement;
  /** URL search parameters string, e.g. location.search */
  search: string;
  /** Storage for music preference. Default: window.localStorage */
  store?: KeyValueStore | null;
  /** Initial unsupported message if WebGPU/WebGL2 are missing */
  unsupportedMessage?: string | null;
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

const FACT_ROTATION_INTERVAL_MS = 6000;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readManifestFiles(json: unknown, setName: string): Record<string, ManifestFile> | null {
  if (!isRecord(json) || !isRecord(json.sets)) {
    return null;
  }
  const set = json.sets[setName];
  if (!isRecord(set) || !isRecord(set.files)) {
    return null;
  }
  const files: Record<string, ManifestFile> = {};
  for (const [name, value] of Object.entries(set.files)) {
    if (isRecord(value) && typeof value.bytes === 'number' && Number.isFinite(value.bytes)) {
      files[name] = { bytes: value.bytes };
    }
  }
  return files;
}

function pathnameOf(name: string): string {
  try {
    return new URL(name).pathname;
  } catch {
    return name;
  }
}

/** Fallback helper to safely read window.localStorage */
function safeLocalStorage(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * `countEnvironment` is true only under the ?sky=hdr diagnostic: the default sky is generated in
 * memory and requests no environment file.
 */
export function trackFirstFrameProgress(
  contentBase: string,
  onProgress: (reading: ProgressReading) => void,
  countEnvironment = false,
): () => void {
  let expected = 0;
  let expectedPaths: string[] = [];
  let fromCache = false;
  let stopped = false;

  function contentEntries(): ResourceEntry[] {
    const readings: ResourceEntry[] = [];
    if (typeof performance === 'undefined' || !performance.getEntriesByType) {
      return readings;
    }
    for (const measured of performance.getEntriesByType('resource')) {
      const resource: {
        entryType?: string;
        name?: string;
        transferSize?: number;
        responseEnd?: number;
      } = measured;
      if (resource.entryType !== 'resource' || typeof resource.name !== 'string') {
        continue;
      }
      readings.push({
        name: resource.name,
        transferSize: typeof resource.transferSize === 'number' ? resource.transferSize : 0,
        responseEnd: typeof resource.responseEnd === 'number' ? resource.responseEnd : 0,
      });
    }
    return readings;
  }

  function countEnded(mine: ResourceEntry[]): number {
    const arrived = new Set(mine.map((one) => pathnameOf(one.name)));
    return expectedPaths.filter((path) => arrived.has(path)).length;
  }

  function update(): void {
    if (stopped) {
      return;
    }
    const mine = contentEntries().filter((one) => expectedPaths.includes(pathnameOf(one.name)));
    const received = receivedBytes(mine, contentBase);
    if (!fromCache && mine.length > 0) {
      const first = mine.reduce((left, right) => (right.responseEnd < left.responseEnd ? right : left));
      if (first.transferSize === 0) {
        fromCache = true;
      }
    }
    const ended = countEnded(mine);
    onProgress({
      received,
      expected,
      ended,
      totalFiles: expectedPaths.length,
      fromCache,
    });
  }

  let observer: PerformanceObserver | null = null;
  if (typeof PerformanceObserver !== 'undefined') {
    try {
      observer = new PerformanceObserver(() => {
        update();
      });
      observer.observe({ type: 'resource', buffered: true });
    } catch {
      // PerformanceObserver type resource may not be supported in some environments
    }
  }

  const ticker = window.setInterval(update, 250);

  void (async () => {
    try {
      const [manifestResponse, catalog] = await Promise.all([
        fetch(contentUrl(contentBase, 'manifest.json')),
        loadCatalog(contentUrl(contentBase, 'catalog.json')),
      ]);
      if (manifestResponse.ok) {
        const setName = contentBase.endsWith('/half') ? 'half' : 'full';
        const files = readManifestFiles(await manifestResponse.json(), setName);
        const firstLook = catalog.looks[0]?.file ?? '';
        const environmentFile = countEnvironment ? catalog.environment.file : null;
        expected = files === null ? 0 : expectedBytes(files, firstLook, environmentFile);
        expectedPaths = [
          ...(environmentFile === null ? [] : [environmentFile]),
          catalog.rotunda.file,
          catalog.plinth.file,
          firstLook,
        ].map((file) => contentUrl(contentBase, file));
        update();
      }
    } catch (err) {
      console.warn('[archviz] progress tracker could not load manifest', err);
    }
  })();

  return () => {
    stopped = true;
    observer?.disconnect();
    window.clearInterval(ticker);
  };
}

export function mountEntryLobby(options: EntryLobbyOptions): EntryLobby {
  const doc = options.root?.ownerDocument ?? document;
  const root = options.root ?? doc.body;
  const store = options.store !== undefined ? options.store : safeLocalStorage();

  let lobbyElement = root.querySelector<HTMLElement>('#entry-lobby');
  const isHydrating = lobbyElement !== null;

  if (lobbyElement === null) {
    lobbyElement = doc.createElement('div');
    lobbyElement.id = 'entry-lobby';
    lobbyElement.className = 'entry-lobby';
    lobbyElement.setAttribute('role', 'dialog');
    lobbyElement.setAttribute('aria-modal', 'true');
    lobbyElement.setAttribute('aria-labelledby', 'entry-lobby-title');
    lobbyElement.dataset.state = 'idle';

    lobbyElement.innerHTML = `
      <div class="entry-lobby__scrim" aria-hidden="true"></div>
      <div class="entry-lobby__poster" aria-hidden="true">
        <img src="/poster/hero.jpg" alt="" class="entry-lobby__poster-img" />
      </div>

      <header class="entry-lobby__header">
        <div class="entry-lobby__brand-lockup">
          <div class="entry-lobby__mark" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none">
              <circle cx="50" cy="50" r="45" stroke="currentColor" stroke-width="2.5" />
              <circle cx="50" cy="50" r="40" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2" opacity="0.75" />
              <path d="M 23 48 A 27 27 0 0 1 77 48" stroke="currentColor" stroke-width="2" />
              <line x1="50" y1="13" x2="50" y2="21" stroke="currentColor" stroke-width="2" />
              <line x1="33" y1="20" x2="39" y2="27" stroke="currentColor" stroke-width="1.8" />
              <line x1="67" y1="20" x2="61" y2="27" stroke="currentColor" stroke-width="1.8" />
              <path d="M 45 25 L 50 19 L 55 25 L 55 69 L 45 69 Z" fill="currentColor" />
              <path d="M 33 35 L 41 35 L 41 69 L 33 69 Z" fill="currentColor" />
              <path d="M 59 35 L 67 35 L 67 69 L 59 69 Z" fill="currentColor" />
              <path d="M 21 47 L 29 47 L 29 69 L 21 69 Z" fill="currentColor" />
              <path d="M 71 47 L 79 47 L 79 69 L 71 69 Z" fill="currentColor" />
              <path d="M 19 75 L 23 72 L 77 72 L 81 75 L 77 78 L 23 78 Z" fill="currentColor" />
              <path d="M 27 81 L 73 81 L 71 85 L 29 85 Z" fill="currentColor" />
              <line x1="50" y1="88" x2="50" y2="92" stroke="currentColor" stroke-width="2" />
              <line x1="37" y1="88" x2="33" y2="91" stroke="currentColor" stroke-width="1.5" />
              <line x1="63" y1="88" x2="67" y2="91" stroke="currentColor" stroke-width="1.5" />
            </svg>
          </div>
          <div class="entry-lobby__divider" aria-hidden="true"></div>
          <div class="entry-lobby__wordmark-text">
            <span class="entry-lobby__title" id="entry-lobby-title">FASHION ROTUNDA</span>
            <span class="entry-lobby__subtitle">HAUTE COUTURE ARCHIVE</span>
          </div>
        </div>
        <div class="entry-lobby__header-controls">
          <button type="button" class="entry-lobby__music-switch" data-music="armed" aria-pressed="true">
            <svg class="music-switch__glyph" viewBox="0 0 16 16" aria-hidden="true">
              <ellipse cx="5.2" cy="12.3" rx="3.1" ry="2.3" transform="rotate(-14 5.2 12.3)"></ellipse>
              <rect x="7.6" y="2.6" width="1.3" height="9.8"></rect>
              <path d="M8.9 2.6c2.7 1.6 3.9 3.8 3.2 6.7-.3-2.4-1.5-3.9-3.2-4.6z"></path>
            </svg>
            <span class="music-switch__label">Music on</span>
          </button>
        </div>
      </header>

      <div class="entry-lobby__content">
        <div class="entry-lobby__card">
          <div class="entry-lobby__card-inner-frame" aria-hidden="true"></div>
          <div class="entry-lobby__corner-accent entry-lobby__corner-accent--tl" aria-hidden="true"></div>
          <div class="entry-lobby__corner-accent entry-lobby__corner-accent--tr" aria-hidden="true"></div>
          <div class="entry-lobby__corner-accent entry-lobby__corner-accent--bl" aria-hidden="true"></div>
          <div class="entry-lobby__corner-accent entry-lobby__corner-accent--br" aria-hidden="true"></div>

          <div class="entry-lobby__idle-pane">
            <p class="entry-lobby__eyebrow">AN INTERACTIVE EXHIBITION OF HAUTE COUTURE &amp; ARCHITECTURE</p>
            <p class="entry-lobby__desc">Step inside the glazed rotunda to explore archival couture silhouettes beneath the daylight dome.</p>
            <noscript>
              <p class="entry-lobby__noscript">JavaScript is required to load and interact with the 3D Fashion Rotunda exhibition.</p>
            </noscript>
            <div class="entry-lobby__action-area">
              <button type="button" class="entry-lobby__load-btn" id="lobby-load-btn">
                <span class="entry-lobby__btn-corner entry-lobby__btn-corner--tl" aria-hidden="true"></span>
                <span class="entry-lobby__btn-corner entry-lobby__btn-corner--tr" aria-hidden="true"></span>
                <span class="entry-lobby__btn-corner entry-lobby__btn-corner--bl" aria-hidden="true"></span>
                <span class="entry-lobby__btn-corner entry-lobby__btn-corner--br" aria-hidden="true"></span>
                LOAD EXPERIENCE
              </button>
            </div>
            <p class="entry-lobby__telemetry" aria-hidden="true">WEBGPU NATIVE &bull; WEBGL 2 FALLBACK &bull; THREE-LIGHT STUDIO RIG &bull; KTX2</p>
          </div>

          <div class="entry-lobby__loading-pane" hidden>
            <h2 class="entry-lobby__loading-title">LOADING YOUR EXPERIENCE</h2>
            <div class="entry-lobby__bar-container">
              <progress class="entry-lobby__progress-bar" max="1" value="0" aria-label="Exhibition loading progress"></progress>
            </div>
            <p class="entry-lobby__status" aria-live="polite">Loading your experience</p>
            <p class="entry-lobby__progress-readout">0.0 MB of 0.0 MB</p>
            <div class="entry-lobby__fact-container">
              <div class="entry-lobby__fact-diamond" aria-hidden="true"></div>
              <span class="entry-lobby__fact-heading">ARCHITECTURAL &amp; GRAPHICS PROVENANCE</span>
              <p class="entry-lobby__fact-text">"Built on WebGPU for next-generation hardware rasterization, with seamless automatic fallback to WebGL 2."</p>
            </div>
          </div>

          <div class="entry-lobby__error-pane" hidden>
            <div class="entry-lobby__error-icon" aria-hidden="true">
              <svg viewBox="0 0 44 44" fill="none">
                <polygon points="22,4 40,38 4,38" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" />
                <line x1="22" y1="16" x2="22" y2="28" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
                <circle cx="22" cy="33" r="1.5" fill="currentColor" />
              </svg>
            </div>
            <h2 class="entry-lobby__error-title">SHOWROOM INITIALIZATION FAILED</h2>
            <p class="entry-lobby__error-message">We were unable to load the 3D showroom assets. Please verify your internet connection and select retry below.</p>
            <button type="button" class="entry-lobby__retry-btn" id="lobby-retry-btn">RETRY LOADING</button>
          </div>
        </div>
      </div>
    `;
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
  lobby.dataset.state = currentState;

  // Music preference state resolution
  let currentMusicPreference = resolveMusicPreference(options.search, store);

  function syncMusicSwitchUI(): void {
    if (musicSwitchBtn === null) {
      return;
    }
    const isPlaying = currentMusicPreference === 'on';
    musicSwitchBtn.dataset.music = isPlaying ? 'armed' : 'off';
    musicSwitchBtn.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
    if (musicLabel !== null) {
      musicLabel.textContent = isPlaying ? 'Music on' : 'Music off';
    }
  }
  syncMusicSwitchUI();

  // Unsupported browser mode handling
  if (options.unsupportedMessage) {
    if (loadBtn !== null) {
      loadBtn.disabled = true;
    }
    if (errorMessage !== null) {
      errorMessage.textContent = options.unsupportedMessage;
    }
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

  // Fact rotation timer
  let factIndex = 0;
  let factTimer: number | null = null;
  let stopProgressTrackingFn: (() => void) | null = null;

  function renderFact(index: number): void {
    const fact = APPROVED_FACTS[index % APPROVED_FACTS.length];
    if (factHeading !== null) {
      factHeading.textContent = fact.heading;
    }
    if (factText !== null) {
      factText.textContent = `"${fact.text}"`;
    }
  }

  function startFactRotation(): void {
    if (prefersReducedMotion() || factTimer !== null) {
      renderFact(0);
      return;
    }
    renderFact(factIndex);
    factTimer = window.setInterval(() => {
      factIndex = (factIndex + 1) % APPROVED_FACTS.length;
      renderFact(factIndex);
    }, FACT_ROTATION_INTERVAL_MS);
  }

  function stopFactRotation(): void {
    if (factTimer !== null) {
      window.clearInterval(factTimer);
      factTimer = null;
    }
  }

  const listeners = new AbortController();

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
    lobby.dataset.state = currentState;

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
      cardElement.dataset.view = 'loading';
    }

    startFactRotation();

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
    { signal: listeners.signal },
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
      if (currentState === 'disposed') {
        return;
      }
      stopFactRotation();
      if (stopProgressTrackingFn !== null) {
        stopProgressTrackingFn();
        stopProgressTrackingFn = null;
      }
      currentState = 'ready-hidden';
      lobby.dataset.state = currentState;

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
      lobby.dataset.state = currentState;
    },

    setBlackHold(): void {
      if (currentState === 'disposed' || currentState === 'error') {
        return;
      }
      currentState = 'black-hold';
      lobby.dataset.state = currentState;
    },

    setRevealing(): void {
      if (currentState === 'disposed' || currentState === 'error') {
        return;
      }
      currentState = 'revealing';
      lobby.dataset.state = currentState;
    },

    setRevealed(): void {
      if (currentState === 'disposed') {
        return;
      }
      currentState = 'revealed';
      lobby.dataset.state = currentState;
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
      stopFactRotation();
      if (stopProgressTrackingFn !== null) {
        stopProgressTrackingFn();
        stopProgressTrackingFn = null;
      }
      currentState = 'error';
      lobby.dataset.state = currentState;

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
        cardElement.dataset.view = 'error';
      }
      if (errorMessage !== null) {
        errorMessage.textContent = message;
      }
      if (retryBtn !== null) {
        retryBtn.focus();
      }
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
      stopFactRotation();
      if (stopProgressTrackingFn !== null) {
        stopProgressTrackingFn();
        stopProgressTrackingFn = null;
      }
      listeners.abort();
      currentState = 'disposed';
      lobby.remove();
    },
  };

  return lobbyHandle;
}
