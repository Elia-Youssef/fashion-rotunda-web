import { expect, test, browserReports } from './support/fixtures';
import type { Page } from '@playwright/test';
import { canvasStats } from './support/pixels';

type Backend = 'webgpu' | 'webgl2';

// This suite relies on three facts of the page: canvas#scene carries data-backend once the renderer
// has initialised, one console line starts with the prefix below, and the badge in the side panel
// names the same backend.
const BACKEND_ATTRIBUTE = 'data-backend';
const BACKEND_LOG_PREFIX = '[archviz] renderer backend:';
const BACKEND_ATTRIBUTE_TIMEOUT = 30_000;
// The scene attribute reaches 'ready' on the first frame that has the look on the plinth. The
// unoptimized content set is about 35 MB for the rotunda and the first look together, so the wait
// is generous; it is a wait on a state, not a sleep.
const SCENE_READY_TIMEOUT = 60_000;

interface CalibrationDraws {
  provisionalHigh: boolean;
  complete: boolean;
  draws: Record<string, number>;
}
type CalibrationWindow = Window & { calibrationDraws?: CalibrationDraws };

test('draws once per display frame during the native tier benchmark', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgpu', 'native High calibration requires WebGPU');
  await page.addInitScript(() => {
    const state: CalibrationDraws = { provisionalHigh: false, complete: false, draws: {} };
    (window as CalibrationWindow).calibrationDraws = state;
    const info = console.info.bind(console);
    console.info = (...args: unknown[]): void => {
      const message = String(args[0]);
      if (message === '[archviz] tier: high') state.provisionalHigh = true;
      if (message.startsWith('[archviz] benchmark p95:')) state.complete = true;
      info(...args);
    };
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback: FrameRequestCallback): number => raf((timestamp) => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas#scene');
      const before = Number(canvas?.dataset['frames'] ?? 0);
      callback(timestamp);
      // Count actual submissions using the existing canvas frame counter, grouped by the shared
      // display timestamp. This observes both drawers without adding a runtime diagnostic.
      const after = Number(canvas?.dataset['frames'] ?? 0);
      if (state.provisionalHigh && !state.complete && canvas?.dataset['scene'] === 'ready') {
        const key = String(timestamp);
        state.draws[key] = (state.draws[key] ?? 0) + after - before;
      }
    });
  });
  await page.goto('/?gate=off&e2e=1&music=off&attract=0');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-backend', 'webgpu', { timeout: BACKEND_ATTRIBUTE_TIMEOUT });
  await expect.poll(() => page.evaluate(() =>
    (window as CalibrationWindow).calibrationDraws?.provisionalHigh),
  { timeout: SCENE_READY_TIMEOUT, message: 'native provisional High calibration must run' }).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    (window as CalibrationWindow).calibrationDraws?.complete),
  { timeout: SCENE_READY_TIMEOUT, message: 'benchmark p95 log acknowledges completion' }).toBe(true);
  const counts = await page.evaluate(() => Object.values((window as CalibrationWindow).calibrationDraws!.draws)
    .filter((count) => count > 0));
  expect(counts.length, 'real room frames observed during calibration').toBeGreaterThan(0);
  expect(Math.max(...counts), 'submissions in a single calibration display frame').toBe(1);
});

function expectedBackend(): Backend {
  return test.info().project.name === 'webgpu' ? 'webgpu' : 'webgl2';
}

function targetPath(backend: Backend): string {
  // ?webgl=1 forces the fallback on a machine that has WebGPU, so the webgl2 project stays
  // testable locally too. gate=off keeps the loading gate away: the pixel check below reads the
  // canvas, and a gate over it would be counted as the room.
  return backend === 'webgpu' ? '/?gate=off' : '/?webgl=1&gate=off';
}

async function skipWhenWebGPUUnavailable(page: Page, backend: Backend): Promise<void> {
  if (backend !== 'webgpu') {
    return;
  }
  // navigator.gpu is exposed only in secure contexts, and the browser's start page (about:blank)
  // is not one, so this runs on the page under test after the goto. Before the goto it returns
  // false even on a machine with a working adapter.
  test.skip(!(await page.evaluate(() => 'gpu' in navigator)), 'WebGPU not available in this browser');
}

test('renders on the expected backend', async ({ page }) => {
  const backend = expectedBackend();

  await page.goto(targetPath(backend));
  await skipWhenWebGPUUnavailable(page, backend);

  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute(BACKEND_ATTRIBUTE, backend, {
    timeout: BACKEND_ATTRIBUTE_TIMEOUT,
  });

  // The badge is the on-screen twin of the attribute: the same backend, upper case, in the side panel.
  await expect(page.locator('aside .badge')).toContainText(backend.toUpperCase());

  const backendLines = browserReports(page).filter((message) => message.kind === 'console' && message.text.startsWith(BACKEND_LOG_PREFIX));
  expect(backendLines, 'exactly one renderer backend console line').toHaveLength(1);
});

test('draws something', async ({ page }) => {
  const backend = expectedBackend();
  await page.goto(targetPath(backend));
  await skipWhenWebGPUUnavailable(page, backend);

  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute(BACKEND_ATTRIBUTE, backend, {
    timeout: BACKEND_ATTRIBUTE_TIMEOUT,
  });

  // Wait for the scene rather than for a stopwatch: data-scene turns 'ready' in the frame that
  // draws the look, so the pixels below are read from a frame that has the room on it. The
  // 2 percent floor catches a background-only canvas; it is not a target.
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

  const stats = await canvasStats(canvas);
  expect(stats.distinctColours, 'distinct colours in the canvas frame').toBeGreaterThanOrEqual(2);
  expect(
    stats.nonBackgroundRatio,
    'share of the frame that is not the background colour',
  ).toBeGreaterThanOrEqual(0.02);
});

// Headless Chrome never requests the tab icon, so a broken icon link would pass every other check:
// read the link the page declares and fetch it the way a browser tab would.
test('links a tab icon the server delivers as the brass SVG mark', async ({ page, request }) => {
  await page.goto('/?gate=off&e2e=1&music=off&attract=0');
  const href = await page.locator('link[rel="icon"]').getAttribute('href');
  expect(href, 'the page links its tab icon').toBe('/brand/fashion-rotunda-icon.svg');
  const response = await request.get(href ?? '');
  expect(response.status(), 'the icon is served').toBe(200);
  expect(response.headers()['content-type'] ?? '', 'the icon is served as SVG').toContain('image/svg+xml');
  expect(await response.text(), 'the icon is the brass copy of the mark').toContain('#c8a97e');
});
