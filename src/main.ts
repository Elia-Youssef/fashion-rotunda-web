// The composition root. Every module it wires exists on its own: the renderer factory (G0.3), the
// proof numbers (G0.4), the tier decision (G0.5) and the render loop with the scaler (G0.6). The cube is
// still the G0.2 placeholder scene; the showroom assets replace it in Phase 1.

import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Mesh,
  MeshStandardNodeMaterial,
  PerspectiveCamera,
  Scene,
} from 'three/webgpu';

import { createLoop } from './loop/loop';
import { ResolutionScaler } from './loop/scaler';
import { FrameTimes } from './proof/frametime';
import { markFirstFrame, snapshot } from './proof/marks';
import { mountOverlay, overlayWanted } from './proof/overlay';
import { createRenderer } from './renderer/create';
import { showLossNotice, showPoster } from './renderer/notices';
import { detectSupport } from './renderer/support';
import { runBenchmark } from './tiers/benchmark';
import { decideTier, tierOverrideFromUrl } from './tiers/decide';
import type { TierInput } from './tiers/decide';
import { TIERS } from './tiers/table';
import type { TierName } from './tiers/table';
import { mountBadge } from './ui/badge';

/** How long the cube keeps turning after the load or an input before the loop goes idle. */
const WAKE_MS = 4000;
/** The calibration run behind a provisional High tier, PLAN.md G0.5 step 1. */
const BENCHMARK_MS = 2000;

const search = location.search;
/** `?webgl=1` forces the WebGL 2 backend on a machine that has WebGPU, so the fallback stays testable. */
const forceWebGL = new URLSearchParams(search).get('webgl') === '1';

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

  const scene = new Scene();
  scene.background = new Color(0x15181c);

  const cube = new Mesh(
    new BoxGeometry(1, 1, 1),
    new MeshStandardNodeMaterial({ color: 0xb8c0c8, roughness: 0.5 }),
  );
  scene.add(cube);

  const sun = new DirectionalLight(0xffffff, 3);
  sun.position.set(3, 5, 2);
  scene.add(sun);
  scene.add(new AmbientLight(0xffffff, 0.3));

  // The proof camera: a hard-coded pose on the cube until views.json exists at G1.5.
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(2.4, 1.8, 3.2);
  camera.lookAt(0, 0, 0);

  let frameCount = 0;
  function drawFrame(): void {
    renderer.info.reset();
    renderer.render(scene, camera);
    frameCount += 1;
    // Readable from outside without exposing the renderer: the e2e tests watch this counter to prove
    // the loop draws when asked and stops when idle.
    canvas.dataset.frames = String(frameCount);
    markFirstFrame();
  }

  // CSS owns the canvas size, so the renderer follows the element's client box and never sets the style.
  function resize(): void {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
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
  const override = tierOverrideFromUrl(search);
  let tier: TierName = override ?? decideTier(tierInput);
  if (override === null && tier === 'high') {
    renderer.setPixelRatio(1);
    resize();
    const benchmarkP95Ms = await runBenchmark({ renderFrame: drawFrame, durationMs: BENCHMARK_MS });
    tier = decideTier({ ...tierInput, benchmarkP95Ms });
    console.info(`[archviz] benchmark p95: ${benchmarkP95Ms.toFixed(2)} ms`);
  }
  const settings = TIERS[tier];
  console.info(`[archviz] tier: ${tier}${override === null ? '' : ' (url override)'}`);
  badge.update({ tier });

  // Resolution is min(device pixel ratio, the tier cap) times the scaler's step. The scaler lowers
  // the backing store only; the CSS box, and so the layout, never changes.
  const scaler = new ResolutionScaler({
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
  let spinning = false;
  const loop = createLoop({
    render: (dtMs) => {
      if (spinning) {
        cube.rotation.y += dtMs * 0.0004;
        cube.rotation.x += dtMs * 0.0002;
      }
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

  // Render on demand: the cube turns for WAKE_MS after the load and after any input, then the loop
  // stops scheduling frames and the GPU idles. A change of the canvas box owes exactly one frame.
  let sleepTimer: number | null = null;
  function wake(): void {
    spinning = true;
    loop.setAnimating(true);
    if (sleepTimer !== null) {
      window.clearTimeout(sleepTimer);
    }
    sleepTimer = window.setTimeout(() => {
      sleepTimer = null;
      spinning = false;
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
}

main().catch((error: unknown) => {
  // Startup failures still land in the console only; the poster path above covers the known case.
  console.error('[archviz] startup failed', error);
});
