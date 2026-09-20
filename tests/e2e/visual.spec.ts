// Goal G2.10: Visual baseline regression gate for WebGL 2 on the proof camera view.

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const SCENE_READY_TIMEOUT = 60_000;
const SWITCH_TIMEOUT = 30_000;
const TEST_TIMEOUT = 120_000;

/** The proof pose from public/content/catalog.json, in metres, and the tolerance the assert uses. */
const PROOF_POSITION: [number, number, number] = [0, 1.7, 4.2];
const POSE_TOLERANCE_M = 0.01;

// Playwright names a baseline after the platform it was taken on: the default template is
// '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{-snapshotSuffix}{ext}'
// (playwright/lib/worker/workerProcessEntry.js line 1256) and the suffix is process.platform
// (playwright/lib/index.js line 352). The committed baselines are '-webgl2-win32.png', taken on
// this machine, so a Linux runner would look for '-webgl2-linux.png' and fail on a missing file.
// The gate skips there until Linux baselines are generated on the runner itself.
test.skip(
  process.platform !== 'win32',
  "the baselines are this machine's; Linux baselines are a later step",
);

function skipUnlessWebgl2(): void {
  test.skip(
    test.info().project.name !== 'webgl2',
    'visual baselines run on the headless webgl2 project only',
  );
}

/**
 * The screenshots are only comparable if the camera stands where the baseline stood. The camera
 * code publishes its handle at window.archvizCamera under the same ?e2e=1 gate this spec uses, and
 * orbit.position is the camera's own position in metres, read after the loop has settled.
 */
async function expectCameraAtProofPose(page: Page): Promise<void> {
  const position = await page.evaluate((): number[] => window.archvizCamera?.orbit.position ?? []);
  expect(position.length, 'window.archvizCamera is mounted under ?e2e=1').toBe(3);
  for (let axis = 0; axis < 3; axis += 1) {
    expect(Math.abs(position[axis] - PROOF_POSITION[axis])).toBeLessThan(POSE_TOLERANCE_M);
  }
}

/**
 * Waits until two consecutive data-frames readings taken 1 second apart are identical,
 * confirming the render loop has settled to idle.
 */
async function waitForLoopSettled(page: Page, canvas: Locator): Promise<void> {
  const readFrames = async (): Promise<number> => Number(await canvas.getAttribute('data-frames'));
  let previous = await readFrames();
  let settled = false;
  for (let attempt = 0; attempt < 15 && !settled; attempt += 1) {
    await page.waitForTimeout(1000);
    const current = await readFrames();
    settled = current > 0 && current === previous;
    previous = current;
  }
  expect(settled, 'the frame counter stopped within 15 seconds').toBe(true);
}

test('visual baselines for the first look and the New Look Dress', async ({ page }) => {
  skipUnlessWebgl2();
  test.setTimeout(TEST_TIMEOUT);

  await page.goto('/?webgl=1&e2e=1');
  const canvas = page.locator('canvas#scene');

  // Wait for the room and the default look to be drawn on the plinth.
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  await waitForLoopSettled(page, canvas);
  await expectCameraAtProofPose(page);

  // Baseline 1: The first look (Wallis Dress).
  await expect(canvas).toHaveScreenshot('first-look.png', {
    maxDiffPixelRatio: 0.02,
    threshold: 0.2,
  });

  // Switch to the New Look Dress.
  const newLookButton = page.locator('#looks button[data-look="new-look-dress"]');
  await expect(newLookButton).toBeVisible({ timeout: SWITCH_TIMEOUT });
  await newLookButton.click();
  // The click focuses the rail button and opens its accessibility tooltip over the canvas. The
  // baseline owns renderer output, not transient page chrome, so dismiss it before capturing.
  await page.keyboard.press('Escape');

  await expect(canvas).toHaveAttribute('data-look', 'new-look-dress', { timeout: SWITCH_TIMEOUT });
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  await waitForLoopSettled(page, canvas);
  await expectCameraAtProofPose(page);

  // Baseline 2: The New Look Dress after the switch.
  await expect(canvas).toHaveScreenshot('new-look-dress.png', {
    maxDiffPixelRatio: 0.02,
    threshold: 0.2,
  });
});
