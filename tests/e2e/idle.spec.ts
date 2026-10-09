import { expect, test } from '@playwright/test';
import { waitForSceneInitialization } from './support/ready';

const SCENE_READY_TIMEOUT = 60_000;
// Input owes a scheduled render; allow delayed RAF delivery, as in other frame handshakes.
const INPUT_FRAME_TIMEOUT = 5_000;

// The page draws nothing while idle. The scene draws for a wake window after the load and after
// any input, then the loop stops scheduling frames. canvas#scene[data-frames] counts rendered frames,
// so two equal readings a second apart mean no frame was drawn in between. Headless only: a pointer
// moving over a headed window is an input and would wake the loop.
test('stops drawing when idle and wakes on input', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgl2', 'runs headless, where no pointer can wake the page');

  await page.goto('/?webgl=1&gate=off&e2e=1');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-backend', 'webgl2', { timeout: 30_000 });

  // Wait for content and final initialization before observing the idle frame counter.
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);

  const readFrames = async (): Promise<number> => Number(await canvas.getAttribute('data-frames'));

  let previous = await readFrames();
  let settled = false;
  for (let attempt = 0; attempt < 12 && !settled; attempt += 1) {
    await page.waitForTimeout(1000);
    const current = await readFrames();
    settled = current > 0 && current === previous;
    previous = current;
  }
  expect(settled, 'the frame counter stopped within twelve seconds').toBe(true);

  await page.keyboard.press('ArrowRight');
  // Wait for the input's scheduled frame rather than elapsed wall time.
  await expect.poll(readFrames, {
    timeout: INPUT_FRAME_TIMEOUT,
    message: 'frames drawn after a key press',
  }).toBeGreaterThan(previous);
});
