// The composition root. Every module it wires exists on its own: the renderer factory (G0.3), the
// proof numbers (G0.4), the tier decision (G0.5), the render loop with the scaler (G0.6) and the
// showroom scene (G1.7). The G0.2 cube is gone; the rotunda, the plinth and one look stand in its
// place, loaded from public/content through the catalogue.

import { Color, Mesh, PerspectiveCamera, Scene } from 'three/webgpu';
import type { Material } from 'three/webgpu';

import { mountMusic } from './audio/mount';
import { mountCamera } from './camera/mount';
import type { CameraMount } from './camera/mount';
import { contentUrl, loadCatalog } from './catalog/catalog';
import type { Catalog, CatalogLook } from './catalog/catalog';
import { composeLighting, enableShadows } from './lighting/compose';
import { createLoop } from './loop/loop';
import { ResolutionScaler } from './loop/scaler';
import { createPostChain } from './post/chain';
import type { PostChain } from './post/chain';
import { FrameTimes } from './proof/frametime';
import { createGpuTimes, handleTimestampError } from './proof/gpu';
import { latestLookSwitchMs, markFirstFrame, snapshot } from './proof/marks';
import { PROOF_POSITION, PROOF_TARGET, runProofOrbit } from './proof/orbit-run';
import { mountProofPanel, overlayWanted } from './proof/panel';
import { createRenderer } from './renderer/create';
import { showLossNotice, showPoster } from './renderer/notices';
import { detectSupport } from './renderer/support';
import { SCENE_BACKGROUND, createShowroom } from './scene/showroom';
import type { Showroom } from './scene/showroom';
import { mountShare } from './share/mount';
import { runBenchmark } from './tiers/benchmark';
import { decideTier, tierOverrideFromUrl } from './tiers/decide';
import type { TierInput } from './tiers/decide';
import { TIERS } from './tiers/table';
import type { TierName } from './tiers/table';
import { mountA11y } from './ui/a11y';
import { mountBadge } from './ui/badge';
import { mountChrome } from './ui/chrome';
import { gateWanted, mountLoadingGate } from './ui/loading-gate';

/** What the scene is made of, as the e2e suite reads it. Material names are three.js type strings. */
interface SceneDescription {
  materials: Record<string, number>;
  meshes: number;
  drawCalls: number;
  triangles: number;
}

declare global {
  interface Window {
    /**
     * Test-only handle, mounted in dev and behind `?e2e=1`. The e2e suite drives look switches
     * through it, which no visitor-facing control can do until G5.1 mounts the catalogue UI, and
     * reads back what the loader built.
     */
    archvizE2E?: {
      switchLooks(count: number): Promise<void>;
      describeScene(): SceneDescription;
      /** The lighting rig as the URL carries it, and the music's state, for the browser tests. */
      rigState(): string;
      musicState(): string;
    };
  }
}

/** How long the loop keeps drawing after the load or an input before it goes idle. */
const WAKE_MS = 4000;
/** The calibration run behind a provisional High tier, PLAN.md G0.5 step 1. */
const BENCHMARK_MS = 2000;

/** The two content sets. The half set is the phone build, written by the optimize pass. */
const FULL_CONTENT_BASE = '/content';
const HALF_CONTENT_BASE = '/content/half';

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
 * The half set does not exist until the optimize pass writes it, and a phone must still get a
 * page. A failed fetch of the half catalogue is therefore a warning and a fall back to the full
 * set, not a dead screen.
 */
async function loadContentSet(wantHalf: boolean): Promise<{ base: string; catalog: Catalog }> {
  if (wantHalf) {
    try {
      const catalog = await loadCatalog(contentUrl(HALF_CONTENT_BASE, 'catalog.json'));
      return { base: HALF_CONTENT_BASE, catalog };
    } catch (error) {
      console.warn(
        `[archviz] no content set at ${HALF_CONTENT_BASE}, using ${FULL_CONTENT_BASE}`,
        error,
      );
    }
  }
  const catalog = await loadCatalog(contentUrl(FULL_CONTENT_BASE, 'catalog.json'));
  return { base: FULL_CONTENT_BASE, catalog };
}

/** `?look=<id>`, falling back to the first look in the catalogue with one warning. */
function chooseLook(catalog: Catalog): CatalogLook {
  const first = catalog.looks[0];
  const wanted = params.get('look');
  if (wanted === null) {
    return first;
  }
  const found = catalog.looks.find((look) => look.id === wanted);
  if (found === undefined) {
    console.warn(`[archviz] no look "${wanted}" in the catalogue, showing "${first.id}"`);
    return first;
  }
  return found;
}

/** `?variant=<name>`, falling back to the look's own default with one warning. */
function chooseVariant(look: CatalogLook): string {
  const wanted = params.get('variant');
  if (wanted === null) {
    return look.defaultVariant;
  }
  if (!look.variants.includes(wanted)) {
    console.warn(
      `[archviz] the look "${look.id}" has no variant "${wanted}", showing "${look.defaultVariant}"`,
    );
    return look.defaultVariant;
  }
  return wanted;
}

/**
 * The switch order for the e2e memory check: every step is a real change of look and the last
 * one returns to where the run started, so the two readings of renderer.info.memory compare the
 * same scene with itself.
 */
function switchOrder(ids: string[], startId: string, count: number): string[] {
  const others = ids.filter((id) => id !== startId);
  if (count < 1 || others.length === 0) {
    return [];
  }
  const order: string[] = [];
  for (let step = 0; step < count - 1; step += 1) {
    order.push(others[step % others.length]);
  }
  order.push(startId);
  return order;
}

async function main(): Promise<void> {
  const page = requireElement('main', 'main element');
  const aside = requireElement('aside', 'side panel');

  // Neither backend available means no renderer at all: show the poster and leave the canvas
  // untouched, so the page still explains itself instead of showing a dead rectangle.
  const support = detectSupport();
  if (!support.webgpu && !support.webgl2) {
    showPoster(page, {
      imageUrl: '/poster/hero.jpg',
      message: 'This page needs WebGPU or WebGL 2. Your browser has neither.',
      credit: 'Still from the Unreal Engine original.',
    });
    return;
  }

  const canvas = requireCanvas();

  // The loading gate (G6.5) mounts here, before the renderer, so it is on screen from
  // the first paint; its reveal comes after the content and the controls, further down.
  const gate = gateWanted(search)
    ? mountLoadingGate({ root: document.body, canvas, contentBase: FULL_CONTENT_BASE, onEnter: wake })
    : null;

  // Decided before the renderer exists because it decides how the renderer is built: the timestamp
  // queries and their per-frame resolve serve the panel and nothing else, so a visitor who never
  // asks for the panel pays for neither. Read once, used by the renderer options, by drawFrame and
  // by the mount below, so the three can never disagree.
  const proofOn = overlayWanted(search, import.meta.env.DEV);

  // The tier owns the pixel ratio cap, but the decision needs the backend and the GPU name, which
  // only exist once the renderer is up. Start at the Base cap and apply the tier's cap below.
  const { renderer, backend, gpuName } = await createRenderer({
    canvas,
    pixelRatioCap: TIERS.base.pixelRatioCap,
    forceWebGL,
    trackTimestamp: proofOn,
    onDeviceLost: (info) => showLossNotice(document.body, info, () => location.reload()),
    onError: (error) => console.error('[archviz] renderer error', error),
  });
  console.info(`[archviz] renderer backend: ${backend}`);

  // three's internal Animation loop (src/renderers/common/Animation.js line 81) resets the info
  // counters on every one of its own ticks when autoReset is on, whether or not a frame was rendered,
  // so an idle page would read zero draw calls. The counters are reset here, once per rendered frame,
  // and the proof overlay keeps the last frame's numbers while the loop idles.
  renderer.info.autoReset = false;

  const badge = mountBadge(aside, { backend, gpuName, tier: null });

  // The music switch (G5.6) mounts in the header here, before the content loads, so a
  // visitor can press it while the room is still arriving; the music needs no scene.
  const music = mountMusic({
    headerRoot: requireElement('header', 'page header'),
    search,
    baseUrl: '/content/music',
  });

  canvas.dataset.scene = 'loading';

  /** Null until the catalogue has arrived; the showroom owns the scene and the camera. */
  let showroom: Showroom | null = null;
  /** True once a look stands on the plinth, which is what makes a frame worth marking. */
  let contentOnScreen = false;
  /**
   * Null until the tier has settled, because the settled tier decides which effects the chain
   * builds. From then on it replaces renderer.render for every frame.
   */
  let chain: PostChain | null = null;

  // The tier benchmark measures a render call, so the loop needs something to render before the
  // showroom exists. An empty scene keeps that measurement real; the G0.2 cube was the previous
  // stand-in and the camera never sees geometry, so its aspect does not matter.
  const warmupScene = new Scene();
  warmupScene.background = new Color(SCENE_BACKGROUND);
  const warmupCamera = new PerspectiveCamera(50, 1, 0.1, 100);

  let frameCount = 0;
  let frameWaiters: (() => void)[] = [];
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
      gpuSeries.push(renderer.info.render.timestamp);
      void renderer.resolveTimestampsAsync().catch(handleTimestampError);
    }
    frameCount += 1;
    // Readable from outside without exposing the renderer: the e2e tests watch this counter to prove
    // the loop draws when asked and stops when idle.
    canvas.dataset.frames = String(frameCount);
    // Active GPU resources as geometries/textures, the pair the e2e switch test compares before and
    // after ten look changes. Both counts are lifetime totals of live objects, not per frame, and
    // they only move when a resource is uploaded or disposed, so the write is skipped when nothing
    // changed.
    const reading = `${renderer.info.memory.geometries}/${renderer.info.memory.textures}`;
    if (canvas.dataset.memory !== reading) {
      canvas.dataset.memory = reading;
    }
    if (chain !== null) {
      // Per frame, not once at creation: a runtime fallback to pass-through changes what the chain
      // is doing, and the attribute is what the e2e suite and the overlay read it from.
      publishPostState();
    }
    if (contentOnScreen) {
      // The first frame is the first one with the scene on it: an empty warm-up frame is not what
      // the load number means.
      markFirstFrame();
      if (canvas.dataset.scene !== 'ready') {
        canvas.dataset.scene = 'ready';
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
    showroom?.setAspect(width / height);
    renderer.setSize(width, height, false);
    chain?.setSize(width, height);
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
  console.info(`[archviz] tier: ${tier}${override === null ? '' : ' (url override, provisional)'}`);
  badge.update({ tier });

  // Resolution is min(device pixel ratio, the tier cap) times the scaler's step. The scaler lowers
  // the backing store only; the CSS box, and so the layout, never changes.
  let scaler = new ResolutionScaler({
    budgetMs: settings.frameBudgetMs,
    steps: settings.scalerSteps,
  });
  let renderScale = scaler.scale;
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
  const gpuSeries = createGpuTimes(240);
  const loop = createLoop({
    render: (dtMs) => {
      cameraMount?.update(dtMs);
      showroom?.update(dtMs);
      const fade = showroom?.fading === true ? '1' : '0';
      if (canvas.dataset.fade !== fade) {
        canvas.dataset.fade = fade;
      }
      if (cameraMount?.moving === true) {
        chain?.notifyMotion();
      }
      drawFrame();
    },
    frameCap: isTouch ? settings.frameCapTouch : null,
    onFrameTime: (workMs) => {
      frames.push(workMs);
      const next = scaler.update(frames.p95(), performance.now());
      // hook: post governor
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
  new ResizeObserver(() => {
    resize();
    loop.invalidate();
  }).observe(canvas);
  window.addEventListener('pointerdown', wake, { passive: true });
  window.addEventListener('pointermove', wake, { passive: true });
  window.addEventListener('keydown', wake);
  window.addEventListener('wheel', wake, { passive: true });

  if (proofOn) {
    mountProofPanel(aside, {
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
          post: canvas.dataset.post ?? 'off',
        }),
      measure: async () => {
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
        await runProofOrbit({
          setPose: (pos, tgt) => mount.orbit.setPose(pos, tgt),
          proofPosition: view === null ? PROOF_POSITION : view.position,
          proofTarget: view === null ? PROOF_TARGET : view.target,
          durationMs: 10_000,
          onFrame: () => loop.invalidate(),
          now: () => performance.now(),
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
    const benchmarkP95Ms = await runBenchmark({ renderFrame: drawFrame, durationMs: BENCHMARK_MS });
    console.info(`[archviz] benchmark p95: ${benchmarkP95Ms.toFixed(2)} ms`);
    const settled = decideTier({ ...tierInput, benchmarkP95Ms });
    if (settled !== tier) {
      tier = settled;
      settings = TIERS[tier];
      scaler = new ResolutionScaler({ budgetMs: settings.frameBudgetMs, steps: settings.scalerSteps });
      renderScale = scaler.scale;
      console.info(`[archviz] tier: ${tier} (after the benchmark)`);
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
      canvas.dataset.look = look;
    }
    if (variant !== null) {
      canvas.dataset.variant = variant;
    }
  }

  /** What the post chain is drawing, as the e2e suites read it: "ao,traa", "ao,msaa", "off". */
  function publishPostState(): void {
    const on = chain?.features ?? null;
    const value =
      on === null
        ? 'off'
        : [on.ao ? 'ao' : '', on.traa ? 'traa' : '', on.msaa ? 'msaa' : '']
            .filter((feature) => feature !== '')
            .join(',') || 'off';
    if (canvas.dataset.post !== value) {
      canvas.dataset.post = value;
    }
  }

  try {
    // The phone set is chosen by the tier, and only a touch device can reach a tier that asks for
    // it; on anything else the full set is the only one.
    const { base, catalog } = await loadContentSet(settings.assetSet === 'half-on-touch' && isTouch);
    showroom = createShowroom({
      renderer,
      catalog,
      contentBase: base,
      onChange: () => {
        loop.invalidate();
      },
      decorate: enableShadows,
    });
    // The camera was built square; the canvas box is the aspect it has to keep.
    resize();

    // The studio rig, the environment and the panel, around the showroom's scene. ?rig= carries a
    // serialized rig from a shared link; the level's own values otherwise.
    const rigParam = params.get('rig');
    const lighting = await composeLighting({
      renderer,
      scene: showroom.scene,
      panelRoot: aside,
      shadowMapSize: settings.shadowMapSize,
      sunShadow: true,
      ...(rigParam === null ? {} : { initial: rigParam }),
      onChange: () => {
        loop.invalidate();
      },
    });

    await showroom.loadStatics();
    const look = chooseLook(catalog);
    await showroom.showLook(look.id);
    try {
      await showroom.setVariant(chooseVariant(look));
    } catch (error) {
      // The catalogue names the variants and the look file carries them, and the two are written
      // by different steps. A swatch that does not exist is a content defect worth seeing, but the
      // room and the look are already on screen and taking the page down over it helps nobody.
      console.warn('[archviz] the look loaded without its variant', error);
    }
    contentOnScreen = true;
    publishSceneState();
    loop.invalidate();
    await settleTier();

    // The settled tier decides which effects the chain builds, which is why the chain is created
    // here and not before the benchmark: the benchmark measures the plain render it calibrates on.
    chain = createPostChain({
      renderer,
      scene: showroom.scene,
      camera: showroom.camera,
      tier: settings,
      isTouch,
    });
    publishPostState();
    loop.invalidate();
    // TRAA accumulates over frames and this loop stops drawing when nothing moves, so without a
    // wake the page would idle on the first frame of the history. One wake window lets it converge
    // before the loop goes quiet, and a visitor who never touches the page still sees a settled
    // picture.
    wake();

    // Hooks. Each later feature adds exactly one call here, against the handles above: the camera
    // (G4.1, G4.4) mounts its controls on the canvas and the loop, the chrome (G5.1, G5.2)
    // mounts the catalogue strip and the product card in the side panel. Nothing else changes here.
    const cameraHandle = mountCamera({
      camera: showroom.camera,
      canvas,
      showroom,
      loop,
      proofView: catalog.views.proof,
    });
    cameraMount = cameraHandle;
    proofView = catalog.views.proof;
    mountChrome({
      catalog,
      contentBase: base,
      stripRoot: requireElement('#looks', 'looks strip'),
      cardRoot: aside,
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
      root: aside,
      search,
      showroom,
      defaultLook: catalog.looks[0].id,
      defaultVariant: catalog.looks[0].defaultVariant,
      lighting,
      camera: cameraHandle,
      music,
      postFeatures: () => canvas.dataset.post ?? 'off',
      proofTarget: catalog.views.proof.target,
      renderer,
      canvas,
      drawFrame,
      onChange: () => loop.invalidate(),
    });
    mountA11y({ root: document.body, aside, canvas, search });
    // A let's narrowing does not reach inside a closure, so the non-null showroom is bound to a
    // const for the compile; switchLooks rebinds the same way for the same reason.
    const room = showroom;
    await gate?.ready(() => renderer.compileAsync(room.scene, room.camera));

    if (import.meta.env.DEV || params.get('e2e') === '1') {
      const ids = catalog.looks.map((entry) => entry.id);
      window.archvizE2E = {
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
      };
    }
  } catch (error) {
    canvas.dataset.scene = 'error';
    console.error('[archviz] the showroom failed to load', error);
  }
}

main().catch((error: unknown) => {
  // Startup failures still land in the console only; the poster path above covers the known case.
  console.error('[archviz] startup failed', error);
});
