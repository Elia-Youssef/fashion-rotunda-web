// Goal G6.5: the entry gate. One dialog over the page from the first script until the visitor
// taps Enter: a byte readout fed by the manifest against Resource Timing, the room's name, and
// one button that unlocks once the scene and its shaders are ready. The tap is the first gesture
// the music waits for; this module never touches the music and never stops an event, so the
// capture-phase listener in src/audio/mount.ts sees the button's pointerdown on its own.
//
// The gate is appended to body and holds no z-index, so it paints over the page's own elements,
// which come before it; the loss notice appends to body later still and therefore paints over the
// gate. Painting order among positioned siblings without z-index is document order, last on top.

import './loading-gate.css';

import { contentUrl, loadCatalog } from '../catalog/catalog';
import { expectedBytes, formatProgress, progressRatio, receivedBytes } from '../loading/progress';
import type { ManifestFile, ResourceEntry } from '../loading/progress';

export interface LoadingGateOptions {
  /** Where the gate mounts, document.body. */
  root: HTMLElement;
  /** The canvas whose data-scene the gate watches. */
  canvas: HTMLCanvasElement;
  /** '/content' or '/content/half': the base the page loads from; the gate reads its manifest. */
  contentBase: string;
  /** Called once when the visitor taps Enter, after the gate is gone. */
  onEnter: () => void;
}

export interface LoadingGate {
  /**
   * Called by the composition root once the scene is on screen: awaits `compile` (the renderer's
   * shader compile), then enables the Enter button. Resolves when the button is enabled.
   */
  ready(compile: () => Promise<void>): Promise<void>;
  readonly state: 'loading' | 'ready' | 'entered';
  dispose(): void;
}

/** How often the readout recomputes, so a long single GLB still shows life between file ends. */
const TICK_MS = 250;
/** The compile is behind the loader, but a compile that never ends must not lock the door. */
const COMPILE_TIMEOUT_MS = 10_000;
/** The fade on the way out; prefers-reduced-motion replaces it with an instant removal. */
const FADE_MS = 200;
/** The id that ties the dialog to its title for assistive tech. */
const TITLE_ID = 'loading-gate-title';
/** The User Timing mark src/proof/marks.ts records inside the first rendered frame. */
const FIRST_FRAME_MARK = 'first-frame';
/** What the status says when main.ts reports the showroom failed; the gate must still open. */
const FAILURE_STATUS = 'The room did not load. Close this to see the page.';

/** True when the URL wants the gate: absent, or any parameter except `e2e=1` and `gate=off`. */
export function gateWanted(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get('e2e') !== '1' && params.get('gate') !== 'off';
}

/** The set name inside manifest.json for a content base: the full set, or the phone's half set. */
function setForBase(contentBase: string): string {
  return contentBase.endsWith('/half') ? 'half' : 'full';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reads the manifest's { bytes } map for the set, structurally: the document is written by the
 * optimize pass and a field this gate can live without must not stop the page. Null means the
 * document was missing or shaped differently, and the bar runs without a total.
 */
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

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** The path of a Resource Timing name; a name that is already a path comes back unchanged. */
function pathnameOf(name: string): string {
  try {
    return new URL(name).pathname;
  } catch {
    return name;
  }
}

export function mountLoadingGate(options: LoadingGateOptions): LoadingGate {
  const dialog = document.createElement('div');
  dialog.className = 'loading-gate';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.dataset.gate = 'loading';

  const title = document.createElement('h2');
  title.id = TITLE_ID;
  title.className = 'loading-gate__title';
  title.textContent = 'Fashion Rotunda';
  dialog.setAttribute('aria-labelledby', TITLE_ID);

  const status = document.createElement('p');
  status.className = 'loading-gate__status';
  status.textContent = 'Loading the room';

  const bar = document.createElement('progress');
  bar.className = 'loading-gate__bar';
  bar.max = 1;
  bar.value = 0;

  const readout = document.createElement('p');
  readout.className = 'loading-gate__readout';
  readout.textContent = formatProgress(0, 0);

  const enter = document.createElement('button');
  enter.type = 'button';
  enter.className = 'loading-gate__enter';
  enter.disabled = true;
  enter.textContent = 'Enter';

  dialog.append(title, status, bar, readout, enter);
  // Focusable but not tabbable, and focused on mount: until the Enter button is enabled the gate
  // holds no tabbable element, and focus left on body would send the first Tab to the music switch
  // behind the scrim. The keydown containment below then sees every Tab, wherever focus sits.
  dialog.tabIndex = -1;
  options.root.appendChild(dialog);
  dialog.focus();

  let gateState: 'loading' | 'ready' | 'entered' = 'loading';
  let compiling = false;
  let expected = 0;
  /** The three first-frame file paths, for the "N of M files" half of the status line. */
  let expectedPaths: string[] = [];
  /** Set once the first of the counted files arrived with transferSize 0: the warm-load reading. */
  let fromCache = false;
  /** performance.now() when the canvas first reported data-scene 'ready'; null before that. */
  let sceneReadyAt: number | null = null;

  function setStatus(text: string): void {
    status.textContent = text;
  }

  /** Resource Timing as plain data, read the way src/proof/marks.ts reads it: no casts. */
  function contentEntries(): ResourceEntry[] {
    const readings: ResourceEntry[] = [];
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
    if (gateState !== 'loading' || compiling) {
      return;
    }
    // Only the three files the first frame waits for count. Everything else under the base (the
    // transcoder, the strip's thumbnails, the music, the manifest itself) would push the bar to 1
    // before the look arrived and print more received bytes than the total.
    const mine = contentEntries().filter((one) => expectedPaths.includes(pathnameOf(one.name)));
    const received = receivedBytes(mine, options.contentBase);
    if (!fromCache && mine.length > 0) {
      // The first arrival decides: transferSize 0 means the browser served it from its cache,
      // and the rest of a warm load reads the same way.
      const first = mine.reduce((left, right) => (right.responseEnd < left.responseEnd ? right : left));
      if (first.transferSize === 0) {
        fromCache = true;
      }
    }
    // Before the manifest answers there is no total, and progressRatio's documented "expected 0
    // means 1" would flash a full bar for one tick; an empty bar is the honest picture until then.
    bar.value = expected > 0 ? progressRatio(received, expected) : 0;
    readout.textContent = formatProgress(received, expected);
    // Resource Timing reports a file only when it has fully arrived, so the bar steps per file;
    // the count says so on the status line instead of the bar pretending to stream.
    const base = fromCache ? 'Loading from cache' : 'Loading the room';
    setStatus(
      expectedPaths.length === 0 ? base : `${base} - ${countEnded(mine)} of ${expectedPaths.length} files`,
    );
  }

  // The observer catches each file as it ends; the ticker keeps the line alive between files.
  // Both only call update(), which re-reads the entries, so neither can double-count.
  let observer: PerformanceObserver | null = null;
  if (typeof PerformanceObserver !== 'undefined') {
    observer = new PerformanceObserver(() => {
      update();
    });
    observer.observe({ type: 'resource', buffered: true });
  }
  let ticker: number | null = window.setInterval(() => {
    update();
  }, TICK_MS);

  /** The readout's two sources, stopped together: once the load is over neither has anything to say. */
  function stopReadout(): void {
    observer?.disconnect();
    observer = null;
    if (ticker !== null) {
      window.clearInterval(ticker);
      ticker = null;
    }
  }

  /**
   * main.ts writes data-scene="error" when the showroom throws. Without this arm the gate would
   * stay up forever with a disabled button, hiding the page behind a room that is never coming;
   * the visitor gets a plain way out instead, and the tap removes the gate as usual.
   */
  function openAfterFailure(): void {
    if (gateState !== 'loading') {
      return;
    }
    stopReadout();
    gateState = 'ready';
    dialog.dataset.gate = 'ready';
    setStatus(FAILURE_STATUS);
    enter.disabled = false;
    enter.focus();
  }

  const sceneWatcher = new MutationObserver(() => {
    const scene = options.canvas.dataset.scene;
    if (scene === 'error') {
      openAfterFailure();
      return;
    }
    if (scene === 'ready' && sceneReadyAt === null) {
      sceneReadyAt = performance.now();
    }
  });
  sceneWatcher.observe(options.canvas, { attributes: true, attributeFilter: ['data-scene'] });

  // The gate reads the same documents the page does, without awaiting either fetch anywhere in
  // the boot path: the browser serves the second request from cache, and the gate must not delay
  // the page by a millisecond.
  void (async (): Promise<void> => {
    try {
      const request = globalThis.fetch.bind(globalThis);
      const [manifestResponse, catalog] = await Promise.all([
        request(contentUrl(options.contentBase, 'manifest.json')),
        loadCatalog(contentUrl(options.contentBase, 'catalog.json'), request),
      ]);
      if (!manifestResponse.ok) {
        throw new Error(`the manifest answered ${manifestResponse.status}`);
      }
      const files = readManifestFiles(
        await manifestResponse.json(),
        setForBase(options.contentBase),
      );
      const firstLook = catalog.looks[0]?.file ?? '';
      expected = files === null ? 0 : expectedBytes(files, firstLook);
      expectedPaths = [catalog.rotunda.file, catalog.plinth.file, firstLook].map((file) =>
        contentUrl(options.contentBase, file),
      );
      update();
    } catch (error) {
      console.warn('[archviz] the loading gate could not read its numbers; the bar has no total', error);
    }
  })();

  const listeners = new AbortController();
  // The gate holds at most one tabbable element, so Tab has nowhere inside to go and the default
  // move would land on the music switch under the scrim. The listener sits on the document, not on
  // the dialog, because before the button is enabled focus may sit on the dialog itself or on body
  // after a click on the scrim, and a keydown there never reaches a listener on the dialog.
  document.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        event.preventDefault();
      }
    },
    { signal: listeners.signal },
  );
  enter.addEventListener(
    'click',
    () => {
      if (gateState !== 'ready') {
        return;
      }
      gateState = 'entered';
      const fade = prefersReducedMotion() ? 0 : FADE_MS;
      dialog.classList.add('loading-gate--leaving');
      window.setTimeout(() => {
        stopWatchers();
        dialog.remove();
        options.onEnter();
      }, fade);
    },
    { signal: listeners.signal },
  );

  function stopWatchers(): void {
    stopReadout();
    sceneWatcher.disconnect();
    listeners.abort();
  }

  /**
   * The scene's timestamp. The MutationObserver cannot run while a synchronous compile holds the
   * thread, so its reading lags the real first frame by however long that compile took; the mark
   * src/proof/marks.ts records inside the frame itself is the reference whenever it exists.
   */
  function sceneReadyMs(): number | null {
    const marks = performance.getEntriesByName(FIRST_FRAME_MARK);
    if (marks.length > 0) {
      return marks[0].startTime;
    }
    return sceneReadyAt;
  }

  async function ready(compile: () => Promise<void>): Promise<void> {
    if (compiling || gateState !== 'loading') {
      return;
    }
    compiling = true;
    setStatus('Compiling the shaders');
    const startedAt = performance.now();
    let timedOut = false;
    let failure: unknown = null;
    await new Promise<void>((resolve) => {
      const giveUp = window.setTimeout(() => {
        timedOut = true;
        resolve();
      }, COMPILE_TIMEOUT_MS);
      void compile().then(
        () => {
          window.clearTimeout(giveUp);
          resolve();
        },
        (error: unknown) => {
          failure = error;
          window.clearTimeout(giveUp);
          resolve();
        },
      );
    });
    const compileMs = performance.now() - startedAt;
    if (timedOut) {
      console.warn(
        `[archviz] the shader compile did not finish in ${COMPILE_TIMEOUT_MS / 1000} s; entering anyway`,
      );
    } else if (failure !== null) {
      console.warn('[archviz] the shader compile failed; entering anyway', failure);
    }
    // The readout's job ended with the load; a visitor who waits before tapping does not keep
    // paying for observers.
    stopReadout();
    gateState = 'ready';
    dialog.dataset.gate = 'ready';
    setStatus('Ready');
    enter.disabled = false;
    enter.focus();
    const enabledAt = performance.now();
    const sceneAt = sceneReadyMs();
    const gapMs = sceneAt === null ? null : enabledAt - sceneAt;
    const ms = (value: number | null): string => (value === null ? 'n/a' : `${value.toFixed(0)}ms`);
    console.info(
      `[archviz] gate: scene-ready=${ms(sceneAt)} compile=${compileMs.toFixed(0)}ms ` +
        `button=${enabledAt.toFixed(0)}ms gap=${ms(gapMs)}`,
    );
  }

  return {
    ready,
    get state(): 'loading' | 'ready' | 'entered' {
      return gateState;
    },
    dispose(): void {
      stopWatchers();
      dialog.remove();
      // A disposed gate is off the page for good, so its state must read like the one after the
      // tap; leaving it on 'loading' would let a later ready() call re-enable a detached button.
      gateState = 'entered';
    },
  };
}
