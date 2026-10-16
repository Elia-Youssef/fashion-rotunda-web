// The composition root. Every module it wires exists on its own: the renderer factory, the
// proof numbers, the tier decision, the render loop with the scaler and the showroom scene.
// The rotunda, the plinth and one look load from public/content through the catalogue.

import { Color, Mesh, PerspectiveCamera, Scene } from 'three/webgpu';
import type { Material } from 'three/webgpu';

import { mountMusic } from './audio/mount';
import { mountCamera } from './camera/mount';
import type { CameraMount } from './camera/mount';
import { mountModeSwitch } from './camera/mode-switch';
import { contentUrl } from './catalog/catalog';
import { FULL_CONTENT_BASE, loadContentSet, chooseLook, chooseVariant, switchOrder } from './catalog/bootstrap';
import { composeLighting, enableShadows } from './lighting/compose';
import { info } from './log';
import { createLoop } from './loop/loop';
import type { LoopDiagnostics } from './loop/loop';
import { RecoveryEligibility } from './loop/recovery';
import { ResolutionScaler } from './loop/scaler';
import { createPostChain, preparePostChain } from './post/chain';
import type { PostChain } from './post/chain';
import { postChainRebuildAllowed } from './post/chain';
import type { GovernorDiagnostics } from './post/governor';
import { FrameTimes } from './proof/frametime';
import {
  createGovernorPublisher, createPostStatePublisher, createMemoryPublisher, createTimestampResolveBridge,
} from './proof/publishers';
import { latestLookSwitchMs, markFirstFrame, snapshot } from './proof/marks';
import { loadProof } from './proof/load';
import { createRenderer, describeRendererError } from './renderer/create';
import { withCompilationDeadline } from './renderer/compile-deadline';
import { showLossNotice, showPoster } from './renderer/notices';
import { detectSupport } from './renderer/support';
import { SCENE_BACKGROUND, createShowroom } from './scene/showroom';
import type { Showroom, TurntableState } from './scene/showroom';
import { mountShare } from './share/mount';
import { runBenchmark } from './tiers/benchmark';
import { decideTier, tierOverrideFromUrl } from './tiers/decide';
import type { TierInput } from './tiers/decide';
import { TIERS } from './tiers/table';
import type { TierName } from './tiers/table';
import { mountA11y } from './ui/a11y';
import { mountPageAnnouncer } from './ui/announce';
import { mountBadge } from './ui/badge';
import { mountChrome } from './ui/chrome';
import { mountShell } from './ui/shell';
import { createAudioEngine } from './audio/engine';
import { lobbyWanted, mountEntryLobby } from './ui/entry-lobby';
import type { EntryLobby } from './ui/entry-lobby';
import { SceneRevealCoordinator } from './ui/scene-reveal';
import type { ReadinessPredicates } from './ui/scene-reveal';
import { createStartupFailureRouting, showStartupNotice } from './ui/startup-failure';
import type { StartupFailureRouting } from './ui/startup-failure';

/** What the scene is made of, as the e2e suite reads it. Material names are three.js type strings. */
interface SceneDescription {
  materials: Record<string, number>;
  meshes: number;
  drawCalls: number;
  triangles: number;
}

declare global {
  interface Window {
    archvizLobby?: EntryLobby | null;
    archvizReveal?: SceneRevealCoordinator | null;
    /**
     * Test-only handle, mounted in dev and behind `?e2e=1`. The e2e suite drives look switches
     * through it without depending on the catalogue UI, and reads back what the loader built.
     */
    archvizE2E?: {
      /** Final initialization is acknowledged by installation of this handle. */
      loopState(): LoopDiagnostics & {
        initialized: true;
        frames: number;
        moving: boolean;
        fading: boolean;
        /** The wake() window is still open: its WAKE_MS timer is armed, whoever owns the loop. */
        wakeOpen: boolean;
        idle: boolean;
      };
      /** Owes one loop frame without opening the continuous wake window. Returns the baseline. */
      requestFrame(): number;
      switchLooks(count: number): Promise<void>;
      describeScene(): SceneDescription;
      /** The lighting rig as the URL carries it, and the music's state, for the browser tests. */
      rigState(): string;
      musicState(): string;
      /** Scene-graph turntable state, kept test-only so yaw coverage is not a canvas scalar check. */
      turntableState(): TurntableState;
      /**
       * Test-only governor control: enables deterministic sampling, injects one synthetic
       * observation with explicit workMs/nowMs/recovery eligibility, and reads the diagnostic
       * snapshot. It never assigns a level directly and exists only under the e2e guard above.
       */
      governor: {
        setDeterministic(on: boolean): void;
        observe(workMs: number, nowMs: number, eligible: boolean): GovernorDiagnostics | null;
        diagnostics(): GovernorDiagnostics | null;
      };
      /** Test-only resolution steps, using the tier's values and retaining the post graph. */
      scaler: {
        setDeterministic(on: boolean): void;
        step(index: number): void;
        diagnostics(): {
          step: number;
          scale: number;
          steps: readonly number[];
          appliedPixelRatio: number;
          deterministic: boolean;
        };
      };
    };
  }
}

/** How long the loop keeps drawing after the load or an input before it goes idle. */
const WAKE_MS = 4000;
/** The two-second calibration run behind a provisional High tier. */
const BENCHMARK_MS = 2000;

/**
 * The unsupported surface's one sentence, shown before the Load press when not even the APIs
 * exist and after it when neither backend can start. No reload repairs absent support, so the
 * Load action stays disabled and there is no retry.
 */
const UNSUPPORTED_BROWSER_MESSAGE =
  'This exhibition requires WebGPU or WebGL 2. Your graphics browser does not support these features.';

const search = location.search;
const params = new URLSearchParams(search);
/** `?webgl=1` forces the WebGL 2 backend on a machine that has WebGPU, so the fallback stays testable. */
const forceWebGL = params.get('webgl') === '1';

function requireCanvas(): HTMLCanvasElement {
  const canvas = document.querySelector<HTMLCanvasElement>('canvas#scene');
  if (canvas === null) {
    throw new Error('index.html has no canvas#scene to render into.');
  }
  return canvas;
}

function requireElement(selector: string, what: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) {
    throw new Error(`index.html has no ${what} (${selector}).`);
  }
  return element;
}

/** navigator.deviceMemory is Chromium-only and absent from lib.dom, so it is read by narrowing. */
function readDeviceMemoryGB(): number | null {
  const nav: Navigator = navigator;
  if ('deviceMemory' in nav && typeof nav.deviceMemory === 'number') {
    return nav.deviceMemory;
  }
  return null;
}

/**
 * The startup-failure routing, assigned as main()'s first act so every throw below it already
 * has a visible surface. Held at module scope for the catch at the bottom of this file, which
 * also runs when main() ends before the assignment.
 */
let startupFailures: StartupFailureRouting | null = null;

async function main(): Promise<void> {
  const showLobby = lobbyWanted(search);
  const lobbyElement = document.getElementById('entry-lobby');
  const headerElement = document.getElementById('shell-header');
  const mainElement = document.querySelector('main');
  const footerElement = document.querySelector('footer');

  let lobby: EntryLobby | null = null;
  let musicPreference: 'on' | 'off' = 'on';
  const routing = createStartupFailureRouting({ lobby: () => lobby });
  startupFailures = routing;
  const announcer = mountPageAnnouncer(document.body);

  if (!showLobby) {
    lobbyElement?.remove();
    headerElement?.removeAttribute('inert');
    headerElement?.removeAttribute('aria-hidden');
    mainElement?.removeAttribute('inert');
    mainElement?.removeAttribute('aria-hidden');
    footerElement?.removeAttribute('inert');
    footerElement?.removeAttribute('aria-hidden');
  } else {
    // Static presence only: no adapter request, no GPU context, no content request. When not
    // even the APIs exist, the unsupported surface is known before the visitor's gesture. APIs
    // that exist but cannot start are decided after the gesture, by detectSupport below.
    const hasWebGpuApi = 'gpu' in navigator;
    const hasWebGl2Api = 'WebGL2RenderingContext' in window;
    if (!hasWebGpuApi && !hasWebGl2Api) {
      lobby = mountEntryLobby({
        search,
        unsupportedMessage: UNSUPPORTED_BROWSER_MESSAGE,
      });
      if (import.meta.env.DEV || params.get('e2e') === '1') {
        window.archvizLobby = lobby;
      }
      return;
    }

    lobby = mountEntryLobby({ search });
    if (import.meta.env.DEV || params.get('e2e') === '1') {
      window.archvizLobby = lobby;
    }
    const loadRequest = await lobby.waitForLoadRequest();
    musicPreference = loadRequest.musicPreference;
  }

  const page = requireElement('main', 'main element');
  const aside = requireElement('aside', 'side panel');
  const shell = mountShell(document);
  // The shell adopts index.html's side panel as its card root; the check keeps the lookup above
  // read and the wiring honest.
  if (shell.roots.card !== aside) {
    throw new Error('the shell did not adopt the side panel as the card root');
  }

  // Neither backend startable means no renderer at all: WebGPU counts only when an adapter
  // answers, WebGL 2 only when a context answers. Both probes are GPU work, so they wait for
  // the Load gesture above; on the lobby path nothing here runs before the press. The page
  // still explains itself instead of showing a dead rectangle.
  const support = await detectSupport();
  if (!support.webgpu && !support.webgl2) {
    if (lobby !== null) {
      lobby.setUnsupported(UNSUPPORTED_BROWSER_MESSAGE);
    } else {
      showPoster(page, {
        imageUrl: '/poster/hero.jpg',
        message: 'This page needs WebGPU or WebGL 2. Your browser has neither.',
        credit: 'Still from the Unreal Engine original.',
      });
    }
    return;
  }

  const canvas = requireCanvas();
  // The raw ?look= value rides along: the tracker resolves it through the catalogue's one look
  // rule, so its expected bytes and file count describe the look the page is about to show.
  let stopProgress =
    lobby !== null ? lobby.trackProgress(FULL_CONTENT_BASE, params.get('look')) : () => {};

  // Decided before the renderer exists because it decides how the renderer is built: the timestamp
  // queries and their per-frame resolve serve the panel and nothing else, so a visitor without
  // the panel pays for neither. Read once, used by the renderer options, by drawFrame and
  // by the mount below, so the three can never disagree.
  const proofTools = await loadProof(search, import.meta.env.DEV);
  const proofOn = proofTools !== null;

  let revealCoordinator: SceneRevealCoordinator | null = null;
  /**
   * Null until the tier has settled, because the settled tier decides which effects the chain
   * builds. From then on it replaces renderer.render for every frame. Declared before the
   * renderer callbacks below so they can drop recovery eligibility on a device error.
   */
  let chain: PostChain | null = null;
  const recovery = new RecoveryEligibility();
  /** True once the scene reveal reached 'revealed', or loading settled on the no-lobby path. */
  let revealSettled = false;
  /** True once a look stands on the plinth, which is what makes a frame worth marking. */
  let contentOnScreen = false;
  /** True once the tier benchmark has finished and tier is settled. */
  let tierSettled = false;
  /** Carried across post-chain rebuilds so a deterministic e2e sequence stays the only input. */
  let e2eDeterministicGovernor = false;

  /**
   * Recovery eligibility: every lifecycle fact must hold before a sample stream may
   * count toward the ten-second qualification. The chain adds its own fallback rule on top.
   */
  function recoveryEligibleNow(): boolean {
    return recovery.eligible(contentOnScreen, tierSettled, revealSettled, !document.hidden);
  }

  function updateRecoveryEligibility(): void {
    chain?.setRecoveryEligible(recoveryEligibleNow());
  }

  // The tier owns the pixel ratio cap, but the decision needs the backend and the GPU name, which
  // only exist once the renderer is up. Start at the Base cap and apply the tier's cap below.
  const { renderer, backend, gpuName } = await createRenderer({
    canvas,
    pixelRatioCap: TIERS.base.pixelRatioCap,
    forceWebGL,
    trackTimestamp: proofOn,
    onDeviceLost: (info) => {
      const message = 'The graphics device was lost. Reload to restore the showroom.';
      recovery.setRendererError(true);
      updateRecoveryEligibility();
      canvas.dataset['scene'] = 'error';
      // The loss notice below is this failure's one announcement (an alert carrying the reason and
      // Reload); the lobby shows the same failure without announcing it a second time.
      const announcedByNotice = { announce: false };
      if (revealCoordinator !== null) {
        revealCoordinator.fail(message, announcedByNotice);
      } else {
        // Before the coordinator exists, the opaque lobby is already the fail-closed surface.
        lobby?.setError(message, announcedByNotice);
      }
      showLossNotice(document.body, info, () => location.reload());
    },
    onError: (error) => {
      // The message goes out as text: the console's preview of the error object cuts it short.
      console.error('[archviz] renderer error', describeRendererError(error), error);
      recovery.setRendererError(true);
      updateRecoveryEligibility();
      canvas.dataset['scene'] = 'error';
      const message = 'Renderer initialization failed. Please retry.';
      if (revealCoordinator !== null) {
        revealCoordinator.fail(message);
      } else {
        lobby?.setError(message);
      }
    },
  });
  info(`[archviz] renderer backend: ${backend}`);

  // three's internal Animation loop (src/renderers/common/Animation.js line 81) resets the info
  // counters on every one of its own ticks when autoReset is on, whether or not a frame was rendered,
  // so an idle page would read zero draw calls. The counters are reset here, once per rendered frame,
  // and the proof overlay keeps the last frame's numbers while the loop idles.
  renderer.info.autoReset = false;

  const badge = mountBadge(shell.roots.proof, { backend, gpuName, tier: null });

  let audioEngine;
  if (musicPreference === 'on') {
    audioEngine = createAudioEngine();
    // The user click was the gesture: unlock context immediately without playing yet
    void audioEngine.unlock();
  }

  // The music switch mounts in the header here, before the content loads, so a
  // visitor can press it while the room is still arriving; the music needs no scene.
  const music = mountMusic({
    headerRoot: shell.roots.header,
    search,
    baseUrl: '/content/music',
    deferPlay: showLobby,
    ...(audioEngine !== undefined ? { engine: audioEngine } : {}),
  });

  canvas.dataset['scene'] = 'loading';

  /** Null until the catalogue has arrived; the showroom owns the scene and the camera. */
  let showroom: Showroom | null = null;
  /** Last CSS canvas box. A changed box needs a fresh temporal post graph on WebGPU. */
  let lastCanvasBoxKey = '';
  /** Reapplied whenever a resize rebuilds the post graph. */
  let depthOfFieldAllowed = true;

  // The tier benchmark measures a render call, so the loop needs something to render before the
  // showroom exists. An empty scene keeps that measurement real; the camera never sees geometry,
  // so its aspect does not matter.
  const warmupScene = new Scene();
  warmupScene.background = new Color(SCENE_BACKGROUND);
  const warmupCamera = new PerspectiveCamera(50, 1, 0.1, 100);

  let frameCount = 0;
  let frameWaiters: (() => void)[] = [];
  /** At most one timestamp resolve in flight; see createTimestampResolveBridge. */
  const requestTimestampResolve = createTimestampResolveBridge(
    () => renderer.resolveTimestampsAsync(),
    (error) => proofTools?.handleTimestampError(error),
  );
  /** Writes the memory attribute only when one of the two resource counts moved. */
  const publishMemory = createMemoryPublisher(canvas.dataset);
  function drawFrame(): void {
    renderer.info.reset();
    if (showroom === null) {
      renderer.render(warmupScene, warmupCamera);
    } else if (chain === null) {
      renderer.render(showroom.scene, showroom.camera);
    } else {
      chain.render();
    }
    if (proofOn) {
      // Read first, then ask for the next resolve: the resolve is asynchronous, so the number
      // standing in info.render.timestamp now is the one an earlier frame's resolve wrote, and the
      // reading lags the frame it belongs to by one. Never awaited here, which would stall the
      // render callback on the GPU.
      gpuSeries?.push(renderer.info.render.timestamp);
      requestTimestampResolve();
    }
    frameCount += 1;
    // Readable from outside without exposing the renderer: the e2e tests watch this counter to prove
    // the loop draws when asked and stops when idle.
    canvas.dataset['frames'] = String(frameCount);
    // Active GPU resources as geometries/textures, the pair the e2e switch test compares before and
    // after ten look changes. Both counts are lifetime totals of live objects, not per frame, and
    // they only move when a resource is uploaded or disposed, so the string is built only then.
    publishMemory(renderer.info.memory.geometries, renderer.info.memory.textures);
    if (chain !== null) {
      // Per frame, not once at creation: a runtime fallback to pass-through changes what the chain
      // is doing, and the attribute is what the e2e suite and the overlay read it from.
      publishPostState(chain);
    }
    if (contentOnScreen) {
      // The first frame is the first one with the scene on it: an empty warm-up frame is not what
      // the load number means. 'error' is terminal, so a later frame must not repaint it ready.
      markFirstFrame();
      if (canvas.dataset['scene'] !== 'ready' && canvas.dataset['scene'] !== 'error') {
        canvas.dataset['scene'] = 'ready';
      }
    }
    if (frameWaiters.length > 0) {
      const waiting = frameWaiters;
      frameWaiters = [];
      for (const resolve of waiting) {
        resolve();
      }
    }
  }

  // CSS owns the canvas size, so the renderer follows the element's client box and never sets the style.
  function resize(): void {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    const boxKey = `${width}:${height}`;
    const boxChanged = boxKey !== lastCanvasBoxKey;
    showroom?.setAspect(width / height);
    renderer.setSize(width, height, false);
    // Three's temporal nodes create GPU history targets lazily in their render ordering. Reusing
    // a graph whose source target was allocated at a different CSS box can make WebGPU copy a
    // new-sized range from its previous-sized GPU texture. Rebuild only for a real box change;
    // pixel-ratio governor steps retain their graph and are still read by the nodes each frame.
    if (chain !== null && boxChanged && postChainRebuildAllowed(chain.fellBack)) {
      rebuildPostChain();
    } else {
      chain?.setSize(width, height);
    }
    lastCanvasBoxKey = boxKey;
  }
  resize();

  // The tier: the URL override wins; otherwise the device decides, and a provisional High is
  // calibrated by the two-second benchmark at pixel ratio 1 before it is trusted.
  const isTouch = window.matchMedia('(pointer: coarse)').matches;
  const tierInput: TierInput = {
    backend,
    gpuName,
    deviceMemoryGB: readDeviceMemoryGB(),
    isTouch,
    viewportWidth: window.innerWidth,
    benchmarkP95Ms: null,
  };
  // The provisional tier picks the content set and the caps; a provisional High is confirmed by the
  // benchmark once the room is on screen (settleTier below), so the measurement is a real frame and
  // not the empty warm-up scene.
  const override = tierOverrideFromUrl(search);
  let tier: TierName = override ?? decideTier(tierInput);
  let settings = TIERS[tier];
  info(`[archviz] tier: ${tier}${override === null ? '' : ' (url override, provisional)'}`);
  badge.update({ tier });

  // Resolution is min(device pixel ratio, the tier cap) times the scaler's step. The scaler lowers
  // the backing store only; the CSS box, and so the layout, never changes.
  let scaler = new ResolutionScaler({
    budgetMs: settings.frameBudgetMs,
    steps: settings.scalerSteps,
  });
  let renderScale = scaler.scale;
  // Only the guarded test handle can suspend real-frame scaler samples.
  let e2eDeterministicScaler = false;
  function applyResolution(): void {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.pixelRatioCap) * renderScale);
    resize();
  }
  applyResolution();

  // Null until the showroom has loaded; then it drives the orbit, the turntable and the loop.
  let cameraMount: CameraMount | null = null;
  /** The pose the camera mounted with, so the Measure run orbits the view the catalogue defines. */
  let proofView: { position: [number, number, number]; target: [number, number, number] } | null =
    null;
  const frames = new FrameTimes();
  // One window per series, the same 240 frames the FrameTimes default holds, so the CPU and GPU
  // percentiles printed side by side cover the same stretch of the run.
  const gpuSeries = proofTools?.createGpuTimes(240) ?? null;
  const loop = createLoop({
    diagnostics: import.meta.env.DEV || params.get('e2e') === '1',
    render: (dtMs) => {
      cameraMount?.update(dtMs);
      showroom?.update(dtMs);
      const fade = showroom?.fading === true ? '1' : '0';
      if (canvas.dataset['fade'] !== fade) {
        canvas.dataset['fade'] = fade;
      }
      if (cameraMount?.moving === true) {
        chain?.notifyMotion();
      }
      drawFrame();
    },
    frameCap: isTouch ? settings.frameCapTouch : null,
    onFrameTime: (workMs) => {
      frames.push(workMs);
      const next = e2eDeterministicScaler ? renderScale : scaler.update(frames.p95(), performance.now());
      chain?.observeFrame(workMs);
      if (next !== renderScale) {
        renderScale = next;
        applyResolution();
        loop.invalidate();
      }
    },
  });

  /** Resolves after the next frame has been drawn, so a reading taken here is a drawn reading. */
  function nextFrame(): Promise<void> {
    return new Promise<void>((resolve) => {
      frameWaiters.push(resolve);
      loop.invalidate();
    });
  }

  // Render on demand: the loop draws for WAKE_MS after the load and after any input, then stops
  // scheduling frames and the GPU idles. A change of the canvas box owes exactly one frame.
  let sleepTimer: number | null = null;
  function wake(): void {
    loop.setAnimating(true);
    if (sleepTimer !== null) {
      window.clearTimeout(sleepTimer);
    }
    sleepTimer = window.setTimeout(() => {
      sleepTimer = null;
      // The camera owns the loop while it glides or turns, and it switches the loop off itself
      // once both are still; the wake window must not cut a motion that is still running short.
      if (cameraMount?.moving === true) {
        return;
      }
      loop.setAnimating(false);
    }, WAKE_MS);
  }
  // The canvas box changes with the window and with the side panel's content (the overlay widens the
  // panel after the first frame), so the observer watches the element, not the window; a window
  // listener left the drawing buffer at the old width and squashed the frame.
  const resizeAndInvalidate = (): void => {
    resize();
    loop.invalidate();
  };
  new ResizeObserver(resizeAndInvalidate).observe(canvas);
  // A transition restart wakes the RAF loop from its own window/visual-viewport listener. Resize
  // the renderer and post chain first in this earlier-registered listener, so WebGPU never renders
  // one new-sized post pass against the previous-sized default framebuffer.
  window.addEventListener('resize', resizeAndInvalidate);
  window.visualViewport?.addEventListener('resize', resizeAndInvalidate);
  window.addEventListener('pointerdown', wake, { passive: true });
  window.addEventListener('pointermove', wake, { passive: true });
  window.addEventListener('keydown', wake);
  window.addEventListener('wheel', wake, { passive: true });
  // A hidden or restored tab, and any page lifecycle interruption, ends recovery
  // qualification immediately. Time spent hidden never counts; restoration starts a fresh
  // ten-second qualification because the accumulated run was cleared on the way out.
  document.addEventListener('visibilitychange', () => {
    updateRecoveryEligibility();
  });
  window.addEventListener('pagehide', () => {
    recovery.pageActive = false;
    updateRecoveryEligibility();
  });
  window.addEventListener('pageshow', () => {
    recovery.pageActive = true;
    updateRecoveryEligibility();
  });

  if (proofTools !== null && gpuSeries !== null) {
    proofTools.mountProofPanel(shell.roots.proof, {
      read: () =>
        snapshot({
          info: renderer.info,
          backend,
          tier,
          pixelRatio: renderer.getPixelRatio(),
          renderScale,
          gpuName,
          frames,
          gpu: { p50: gpuSeries.p50(), p95: gpuSeries.p95(), available: gpuSeries.available },
          lookSwitchMs: latestLookSwitchMs(),
          post: canvas.dataset['post'] ?? 'off',
          governor: canvas.dataset['governor'] ?? 'off',
          governorLog: canvas.dataset['governorLog'] ?? '',
        }),
      measure: async (signal) => {
        if (cameraMount === null) {
          throw new Error('camera not mounted yet');
        }
        const mount = cameraMount;
        // The orbit's percentiles must describe the orbit. Both windows hold the last 240 samples
        // whatever their age, so without this the row could report frames drawn minutes earlier.
        frames.clear();
        gpuSeries.clear();
        // The catalogue's view once the camera has mounted, which is the only state this runs in;
        // the module constants are the fallback and are pinned to the catalogue by a unit test.
        const view = proofView;
        await proofTools.runProofOrbit({
          // The run reuses one position tuple across ticks; setPose consumes it synchronously.
          setPose: (pos, tgt) => mount.orbit.setPose(pos, tgt),
          proofPosition: view === null ? proofTools.PROOF_POSITION : view.position,
          proofTarget: view === null ? proofTools.PROOF_TARGET : view.target,
          durationMs: 10_000,
          onFrame: () => loop.invalidate(),
          now: () => performance.now(),
          signal,
        });
      },
    });
  }

  loop.start();
  wake();

  /** The benchmark on the real room; a provisional High that misses its budget settles to Mid. */
  async function settleTier(): Promise<void> {
    if (override !== null || tier !== 'high') {
      return;
    }
    renderer.setPixelRatio(1);
    resize();
    const benchmarkP95Ms = await runBenchmark({ renderFrame: drawFrame, durationMs: BENCHMARK_MS, loop });
    info(`[archviz] benchmark p95: ${benchmarkP95Ms.toFixed(2)} ms`);
    const settled = decideTier({ ...tierInput, benchmarkP95Ms });
    if (settled !== tier) {
      tier = settled;
      settings = TIERS[tier];
      scaler = new ResolutionScaler({ budgetMs: settings.frameBudgetMs, steps: settings.scalerSteps });
      renderScale = scaler.scale;
      info(`[archviz] tier: ${tier} (after the benchmark)`);
      badge.update({ tier });
    }
    applyResolution();
    loop.invalidate();
  }

  /** The look and the swatch on screen, as the e2e suites read them. */
  function publishSceneState(): void {
    const look = showroom?.currentLook ?? null;
    const variant = showroom?.currentVariant ?? null;
    if (look !== null) {
      canvas.dataset['look'] = look;
    }
    if (variant !== null) {
      canvas.dataset['variant'] = variant;
    }
  }

  /**
   * What the post chain is drawing, as the e2e suites read it: "ao,traa", "ao,traa,ssgi-half,ssr",
   * "off". The committed governor record rides the same per-frame publish, so a decision reaches
   * the canvas and the proof panel only after render() has applied it.
   */
  const publishGovernor = createGovernorPublisher(canvas.dataset);
  const publishPost = createPostStatePublisher(canvas.dataset, publishGovernor);
  function publishPostState(chainNow: PostChain | null): void {
    publishPost(chainNow?.features ?? null, chainNow?.governorDiagnostics ?? null);
  }

  /**
   * Recreates temporal post resources after a CSS canvas-box change without changing its settings.
   * The governor state, the recovery eligibility and the deterministic-sampling flag all ride
   * along, so a rebuild neither resets nor improves quality and never contaminates an injected
   * e2e sequence with real-frame samples.
   */
  function rebuildPostChain(): PostChain | null {
    if (showroom === null) {
      return null;
    }
    const previous = chain;
    const governorState = previous?.governorState;
    chain = createPostChain({
      renderer,
      scene: showroom.scene,
      camera: showroom.camera,
      tier: settings,
      isTouch,
      backend,
      requestFrame: () => {
        loop.invalidate();
      },
      recoveryEligible: recoveryEligibleNow(),
      deterministicSampling: e2eDeterministicGovernor,
      ...(governorState === null || governorState === undefined ? {} : { governorState }),
    });
    chain.setDepthOfFieldAllowed(depthOfFieldAllowed);
    previous?.dispose();
    return chain;
  }

  try {
    // The phone set is chosen by the tier, and only a touch device can reach a tier that asks for
    // it; on anything else the full set is the only one.
    const { base, catalog } = await loadContentSet(settings.assetSet === 'half-on-touch' && isTouch);
    // The tracker above started before the tier and the touch input were known and assumed the
    // full set. A touch device on a tier whose asset set is the half set fetches /content/half,
    // whose paths never match the full-set expectations, so the tracker follows the set that was
    // actually chosen and the ready call below stops that tracker.
    if (lobby !== null && base !== FULL_CONTENT_BASE) {
      stopProgress = lobby.trackProgress(base, params.get('look'));
    }
    showroom = createShowroom({
      renderer,
      catalog,
      contentBase: base,
      onChange: () => {
        loop.invalidate();
      },
      decorate: enableShadows,
      // Preserve the lighting -> statics -> look attachment order while their GLBs prepare
      // concurrently. The loop can draw during loading, before contentOnScreen is published.
      beforeMount: (kind) => kind === 'statics' ? lightingReady : staticsReady,
    });
    // The camera was built square; the canvas box is the aspect it has to keep.
    resize();

    // The studio rig, the environment and the panel, around the showroom's scene. ?rig= carries a
    // serialized rig from a shared link; the level's own values otherwise.
    const rigParam = params.get('rig');
    const lightingReady = composeLighting({
      renderer,
      scene: showroom.scene,
      // The default sky is generated in memory. ?sky=hdr restores the School Field HDR as a
      // diagnostic; it is shared by both geometry sets, so even a phone loads it from the full
      // content root rather than looking for a duplicate under /content/half.
      sky: params.get('sky'),
      environmentUrl: contentUrl(FULL_CONTENT_BASE, catalog.environment.file),
      panelRoot: shell.roots.lightPanel,
      shadowMapSize: settings.shadowMapSize,
      sunShadow: true,
      ...(rigParam === null ? {} : { initial: rigParam }),
      onChange: () => {
        loop.invalidate();
      },
    });

    const staticsReady = showroom.loadStatics();
    const look = chooseLook(catalog, params);
    const firstLookReady = (async () => {
      await showroom.showLook(look.id);
      try {
        await showroom.setVariant(chooseVariant(look, params));
      } catch (error) {
        // The catalogue names the variants and the look file carries them, and the two are written
        // by different steps. A swatch that does not exist is a content defect worth seeing, but the
        // room and the look are already on screen and taking the page down over it helps nobody.
        console.warn('[archviz] the look loaded without its variant', error);
      }
    })();
    // Observe every rejection immediately, then retain the original error priority even when
    // a later request fails first. No readiness state is published until all work has settled.
    const results = await Promise.allSettled([lightingReady, staticsReady, firstLookReady]);
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
    const lighting = await lightingReady;
    contentOnScreen = true;
    publishSceneState();
    loop.invalidate();
    await settleTier();
    tierSettled = true;
    // Without the lobby there is no scene reveal transition to wait for: loading settled is revealed.
    // On the lobby path revealSettled stays false until the coordinator reaches 'revealed'.
    if (!showLobby) {
      revealSettled = true;
    }

    // The settled tier decides which effects the chain builds, which is why the chain is created
    // here and not before the benchmark: the benchmark measures the plain render it calibrates on.
    const postReady = preparePostChain({ tier: settings, isTouch, backend });
    if (postReady !== null) await postReady;
    const initializedChain = rebuildPostChain();
    if (initializedChain === null) {
      throw new Error('the post chain was not created for the loaded showroom');
    }
    loop.invalidate();
    // TRAA accumulates over frames and this loop stops drawing when nothing moves, so without a
    // wake the page would idle on the first frame of the history. One wake window lets it converge
    // before the loop goes quiet, and a visitor who never touches the page still sees a settled
    // picture.
    wake();

    // Hooks against the handles above: the camera mounts its controls on the canvas and the loop,
    // and the chrome mounts the catalogue strip and the product card in the side panel.
    let modeSwitch: ReturnType<typeof mountModeSwitch> | null = null;
    const cameraHandle = mountCamera({
      camera: showroom.camera,
      onDispose: () => modeSwitch?.dispose(),
      canvas,
      showroom,
      loop,
      proofView: catalog.views['proof'],
      views: catalog.views,
      isTouch,
      collisionUrl: contentUrl(base, 'collision.glb'),
      search,
    });
    cameraMount = cameraHandle;
    proofView = catalog.views['proof'];
    modeSwitch = mountModeSwitch(shell.roots.header, cameraHandle, { hasPointerLock: !isTouch, canvas, announcer });
    const finishingPass = initializedChain;
    finishingPass.setDepthOfFieldAllowed(cameraHandle.mode === 'orbit');
    cameraHandle.onModeChange((mode) => {
      depthOfFieldAllowed = mode === 'orbit';
      chain?.setDepthOfFieldAllowed(depthOfFieldAllowed);
    });
    mountChrome({
      announcer,
      catalog,
      contentBase: base,
      stripRoot: requireElement('#looks', 'looks strip'),
      cardRoot: shell.roots.card,
      showroom,
      onRotateToggle: () => {
        cameraHandle.turntable.toggle();
        return cameraHandle.turntable.running;
      },
      onResetCamera: () => {
        // Stop first, then zero: the mount writes the look's yaw and the canvas attribute only
        // from a stopped turntable, so this order leaves both reading zero. The other order left
        // the attribute at the old angle while the look itself stood at zero.
        cameraHandle.turntable.stop();
        cameraHandle.turntable.setYaw(0);
        cameraHandle.orbit.reset();
      },
      onChange: () => {
        publishSceneState();
        loop.invalidate();
      },
    });
    mountShare({
      root: shell.roots.card,
      search,
      showroom,
      defaultLook: catalog.looks[0].id,
      defaultVariant: catalog.looks[0].defaultVariant,
      lighting,
      camera: cameraHandle,
      music,
      postFeatures: () => canvas.dataset['post'] ?? 'off',
      proofTarget: catalog.views['proof'].target,
      renderer,
      canvas,
      drawFrame,
      onChange: () => loop.invalidate(),
    });
    const room = showroom;
    let shadersCompiled = false;
    try {
      await withCompilationDeadline(renderer.compileAsync(room.scene, room.camera));
      shadersCompiled = true;
    } catch (compileError) {
      canvas.dataset['scene'] = 'error';
      console.error('[archviz] shader compilation failed or timed out', compileError);
      routing.fail();
      return;
    }

    drawFrame();
    lobby?.setReady();
    stopProgress();

    if (!showLobby) {
      mountA11y({ root: document.body, aside: shell.roots.card, canvas, search, announcer });
      if (musicPreference === 'on') {
        void music.startDeferred();
      }
    } else {
      const predicates: ReadinessPredicates = {
        rendererExists: () => renderer !== null && renderer !== undefined,
        backendActive: () => backend === 'webgpu' || backend === 'webgl2',
        canvasSized: () =>
          canvas.clientWidth > 0 &&
          canvas.clientHeight > 0 &&
          canvas.width > 0 &&
          canvas.height > 0,
        tierSettled: () => tierSettled,
        showroomExists: () => showroom !== null,
        staticsMounted: () => showroom !== null && showroom.scene.children.length > 0,
        lookAndVariantMounted: () => contentOnScreen,
        cameraPoseActive: () => cameraMount !== null && showroom !== null,
        lightingAttached: () => lighting !== null,
        postChainAssembled: () => chain !== null,
        shadersCompiled: () => shadersCompiled,
        noError: () => canvas.dataset['scene'] !== 'error',
        realFrameCompleted: () => frameCount >= 1 && contentOnScreen,
      };

      const coordinator = new SceneRevealCoordinator({
        canvas,
        search,
        lobby,
        predicates,
        wakeRenderer: () => {
          loop.invalidate();
          wake();
        },
        onFrameRequest: async () => {
          // The coordinator counts only frames delivered by the running RAF loop. This resolves
          // after drawFrame, rather than treating a synchronous renderer call as a committed frame.
          await nextFrame();
        },
        onRevealed: () => {
          headerElement?.removeAttribute('inert');
          headerElement?.removeAttribute('aria-hidden');
          mainElement?.removeAttribute('inert');
          mainElement?.removeAttribute('aria-hidden');
          footerElement?.removeAttribute('inert');
          footerElement?.removeAttribute('aria-hidden');

          // The scene reveal has reached 'revealed': recovery qualification may start accruing now.
          revealSettled = true;
          updateRecoveryEligibility();

          if (mainElement !== null) {
            mainElement.tabIndex = -1;
            mainElement.focus({ preventScroll: true });
          }

          if (musicPreference === 'on') {
            void music.startDeferred();
          }

          const a11y = mountA11y({ root: document.body, aside: shell.roots.card, canvas, search, announcer });
          a11y.announcer.say('Experience ready');
        },
        onError: (err) => {
          canvas.dataset['scene'] = 'error';
          console.error('[archviz] transition error', err);
        },
      });
      revealCoordinator = coordinator;

      if (import.meta.env.DEV || params.get('e2e') === '1') {
        window.archvizReveal = coordinator;
      }

      await coordinator.execute();
    }

    if (import.meta.env.DEV || params.get('e2e') === '1') {
      const ids = catalog.looks.map((entry) => entry.id);
      const readLoopDiagnostics = loop.diagnostics;
      if (readLoopDiagnostics === undefined) {
        throw new Error('loop diagnostics are unavailable for the test handle');
      }
      window.archvizE2E = {
        loopState() {
          const state = readLoopDiagnostics();
          const moving = cameraMount?.moving === true;
          const fading = showroom?.fading === true;
          return {
            ...state,
            initialized: true,
            frames: frameCount,
            moving,
            fading,
            // wake() clears the timer at expiry before it defers to camera-owned motion, so this
            // field separates the wake window from the animating flag the camera keeps set.
            wakeOpen: sleepTimer !== null,
            idle: canvas.dataset['scene'] === 'ready' && state.running && !state.scheduled &&
              !state.animating && !state.invalidated && !moving && !fading,
          };
        },
        requestFrame(): number {
          const before = frameCount;
          loop.invalidate();
          return before;
        },
        async switchLooks(count: number): Promise<void> {
          const active = showroom;
          if (active === null) {
            throw new Error('the showroom has not loaded');
          }
          for (const id of switchOrder(ids, active.currentLook ?? ids[0], count)) {
            await active.showLook(id);
            await active.settle();
            chain?.notifyMotion();
            publishSceneState();
          }
          // The memory counts move when a resource is uploaded, which happens in a render, so the
          // caller is only handed back control once a frame has been drawn.
          await nextFrame();
        },
        describeScene(): SceneDescription {
          const active = showroom;
          if (active === null) {
            throw new Error('the showroom has not loaded');
          }
          // Material.type is the class name as a string literal set in the constructor, which is
          // what survives the production build; constructor.name does not.
          const counted = new Set<Material>();
          const materials: Record<string, number> = {};
          let meshes = 0;
          active.scene.traverse((object) => {
            if (!(object instanceof Mesh)) {
              return;
            }
            meshes += 1;
            const assigned = object.material;
            for (const material of Array.isArray(assigned) ? assigned : [assigned]) {
              if (counted.has(material)) {
                continue;
              }
              counted.add(material);
              materials[material.type] = (materials[material.type] ?? 0) + 1;
            }
          });
          return {
            materials,
            meshes,
            drawCalls: renderer.info.render.drawCalls,
            triangles: renderer.info.render.triangles,
          };
        },
        rigState(): string {
          return lighting.serialize();
        },
        musicState(): string {
          return music.player.state;
        },
        turntableState(): TurntableState {
          const active = showroom;
          if (active === null) {
            throw new Error('the showroom has not loaded');
          }
          return active.turntableState;
        },
        governor: {
          setDeterministic(on: boolean): void {
            e2eDeterministicGovernor = on;
            chain?.governorHarness?.setDeterministic(on);
          },
          observe(workMs: number, nowMs: number, eligible: boolean): GovernorDiagnostics | null {
            return chain?.governorHarness?.observe(workMs, nowMs, eligible) ?? null;
          },
          diagnostics(): GovernorDiagnostics | null {
            return chain?.governorDiagnostics ?? null;
          },
        },
        scaler: {
          setDeterministic(on: boolean): void {
            if (e2eDeterministicScaler && !on) {
              scaler.setScale(renderScale);
            }
            e2eDeterministicScaler = on;
          },
          step(index: number): void {
            if (!e2eDeterministicScaler) {
              throw new Error('deterministic scaler sampling must be enabled before stepping');
            }
            if (!Number.isInteger(index) || index < 0 || index >= settings.scalerSteps.length) {
              throw new RangeError('the scaler step must be an index in the current tier');
            }
            const scale = settings.scalerSteps[index];
            // Same path as a real scaler step: resize the buffer without rebuilding the graph.
            renderScale = scale;
            applyResolution();
            loop.invalidate();
          },
          diagnostics() {
            return {
              step: settings.scalerSteps.indexOf(renderScale),
              scale: renderScale,
              steps: [...settings.scalerSteps],
              appliedPixelRatio: renderer.getPixelRatio(),
              deterministic: e2eDeterministicScaler,
            };
          },
        },
      };
    }
  } catch (error) {
    canvas.dataset['scene'] = 'error';
    console.error('[archviz] the showroom failed to load', error);
    routing.fail();
  }
}

main().catch((error: unknown) => {
  console.error('[archviz] startup failed', error);
  // A throw before the routing exists leaves the console line above as the only context; the
  // notice is the surface that needs the least of the page to work.
  if (startupFailures === null) {
    showStartupNotice(document.body, () => location.reload());
  } else {
    startupFailures.fail();
  }
});
