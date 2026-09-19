// The composition root. Every module it wires exists on its own: the renderer factory (G0.3), the
// proof numbers (G0.4), the tier decision (G0.5), the render loop with the scaler (G0.6) and the
// showroom scene (G1.7). The G0.2 cube is gone; the rotunda, the plinth and one look stand in its
// place, loaded from public/content through the catalogue.

import { Color, Mesh, PerspectiveCamera, Scene } from 'three/webgpu';
import type { Material } from 'three/webgpu';

import { contentUrl, loadCatalog } from './catalog/catalog';
import type { Catalog, CatalogLook } from './catalog/catalog';
import { composeLighting, enableShadows } from './lighting/compose';
import { createLoop } from './loop/loop';
import { ResolutionScaler } from './loop/scaler';
import { FrameTimes } from './proof/frametime';
import { markFirstFrame, snapshot } from './proof/marks';
import { mountOverlay, overlayWanted } from './proof/overlay';
import { createRenderer } from './renderer/create';
import { showLossNotice, showPoster } from './renderer/notices';
import { detectSupport } from './renderer/support';
import { SCENE_BACKGROUND, createShowroom } from './scene/showroom';
import type { Showroom } from './scene/showroom';
import { runBenchmark } from './tiers/benchmark';
import { decideTier, tierOverrideFromUrl } from './tiers/decide';
import type { TierInput } from './tiers/decide';
import { TIERS } from './tiers/table';
import type { TierName } from './tiers/table';
import { mountBadge } from './ui/badge';

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

  // The tier owns the pixel ratio cap, but the decision needs the backend and the GPU name, which
  // only exist once the renderer is up. Start at the Base cap and apply the tier's cap below.
  const { renderer, backend, gpuName } = await createRenderer({
    canvas,
    pixelRatioCap: TIERS.base.pixelRatioCap,
    forceWebGL,
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

  canvas.dataset.scene = 'loading';

  /** Null until the catalogue has arrived; the showroom owns the scene and the camera. */
  let showroom: Showroom | null = null;
  /** True once a look stands on the plinth, which is what makes a frame worth marking. */
  let contentOnScreen = false;

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
    } else {
      renderer.render(showroom.scene, showroom.camera);
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

  const frames = new FrameTimes();
  const loop = createLoop({
    render: () => {
      drawFrame();
    },
    frameCap: isTouch ? settings.frameCapTouch : null,
    onFrameTime: (workMs) => {
      frames.push(workMs);
      const next = scaler.update(frames.p95(), performance.now());
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

  if (overlayWanted(search, import.meta.env.DEV)) {
    mountOverlay(aside, () =>
      snapshot({
        info: renderer.info,
        backend,
        tier,
        pixelRatio: renderer.getPixelRatio(),
        renderScale,
        gpuName,
        frames,
      }),
    );
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
    await composeLighting({
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

    // Hooks. Each later feature adds exactly one call here, against the handles above: the camera
    // (G4.1, G4.4) mounts its controls on the canvas and the loop, the chrome (G5.1, G5.2)
    // mounts the catalogue strip and the product card in the side panel. Nothing else changes here.
    // hook: camera
    // hook: chrome

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
