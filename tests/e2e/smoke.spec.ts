import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';
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
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => messages.push(message));

  await page.goto(targetPath(backend));
  await skipWhenWebGPUUnavailable(page, backend);

  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute(BACKEND_ATTRIBUTE, backend, {
    timeout: BACKEND_ATTRIBUTE_TIMEOUT,
  });

  // The badge is the on-screen twin of the attribute: the same backend, upper case, in the side panel.
  await expect(page.locator('aside .badge')).toContainText(backend.toUpperCase());

  const backendLines = messages.filter((message) => message.text().startsWith(BACKEND_LOG_PREFIX));
  expect(backendLines, 'exactly one renderer backend console line').toHaveLength(1);
  const errors = messages.filter((message) => message.type() === 'error');
  expect(errors, 'no console messages of type error').toHaveLength(0);
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
