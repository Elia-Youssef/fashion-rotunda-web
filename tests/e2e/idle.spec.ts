import { expect, test } from './support/fixtures';
import { backendPath, projectBackend } from './support/backend';
import { LOOP_STATE_POLL_MS, waitForLoopIdle, waitForSceneInitialization } from './support/ready';

const SCENE_READY_TIMEOUT = 60_000;
// Input owes a scheduled render; allow delayed RAF delivery, as in other frame handshakes.
const INPUT_FRAME_TIMEOUT = 5_000;

// The page draws nothing while idle. The scene draws for a wake window after the load and after
// any input, then the loop stops scheduling frames. canvas#scene[data-frames] counts rendered frames,
// and the shared helper verifies the owner state and a fresh frame.
// Both projects default to headless, so only synthetic input wakes the page after it settles.
test('stops drawing when idle and wakes on input', async ({ page }) => {
  await page.goto(backendPath('/?gate=off&e2e=1'));
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-backend', projectBackend(), { timeout: 30_000 });

  // Wait for content and final initialization before observing the idle frame counter.
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);

  const readFrames = async (): Promise<number> => Number(await canvas.getAttribute('data-frames'));

  const previous = await waitForLoopIdle(page);

  await page.keyboard.press('ArrowRight');
  // Wait for the input's scheduled frame rather than elapsed wall time.
  await expect.poll(readFrames, {
    timeout: INPUT_FRAME_TIMEOUT,
    message: 'frames drawn after a key press',
  }).toBeGreaterThan(previous);
});

test('loop diagnostic acknowledges idle and a requested frame', async ({ page }) => {
  const fallback = test.info().project.name === 'webgl2' ? '&webgl=1' : '';
  await page.goto(`/?e2e=1&tier=base&post=off&music=off&attract=0${fallback}`);
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-backend', test.info().project.name, {
    timeout: SCENE_READY_TIMEOUT,
  });
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  await waitForLoopIdle(page);

  // The request and pending-state snapshot share one browser task, before RAF can deliver it.
  const pending = await page.evaluate(() => {
    const hooks = window.archvizE2E!;
    const before = hooks.requestFrame();
    return { before, state: hooks.loopState() };
  });
  expect(pending.state).toMatchObject({
    initialized: true,
    running: true,
    scheduled: true,
    animating: false,
    invalidated: true,
    moving: false,
    fading: false,
    idle: false,
    frames: pending.before,
  });

  const drawn = await page.waitForFunction((before) => {
    const state = window.archvizE2E?.loopState();
    return state?.idle === true && state.frames > before;
  }, pending.before, { polling: LOOP_STATE_POLL_MS, timeout: INPUT_FRAME_TIMEOUT });
  await drawn.dispose();
  expect(await waitForLoopIdle(page)).toBeGreaterThan(pending.before);
});
