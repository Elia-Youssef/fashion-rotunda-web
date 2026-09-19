import { expect, test } from '@playwright/test';

// The loss notice is the page's answer to a GPU that disappears mid-session. WEBGL_lose_context exists
// on WebGL only, so this check runs in the webgl2 project; the WebGPU arm is covered by the unit test
// that calls the installed handler directly (tests/unit/renderer-create.test.ts). The G0.3 audit found
// the notice missing under exactly this check, so it stays in the gate.
test('shows the loss notice with a reload button when the WebGL context is lost', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgl2', 'WEBGL_lose_context is a WebGL extension');

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?webgl=1');
  await expect(page.locator('canvas#scene')).toHaveAttribute('data-backend', 'webgl2', {
    timeout: 30_000,
  });

  await page.evaluate(() => {
    const canvas = document.querySelector('canvas#scene');
    const context = canvas instanceof HTMLCanvasElement ? canvas.getContext('webgl2') : null;
    const extension = context?.getExtension('WEBGL_lose_context');
    if (!extension) {
      throw new Error('WEBGL_lose_context is not available on the page canvas');
    }
    extension.loseContext();
  });

  const notice = page.locator('[role="alert"]');
  await expect(notice).toHaveCount(1);
  await expect(notice.getByRole('button', { name: 'Reload' })).toBeVisible();
  expect(pageErrors, 'no uncaught page errors during the loss').toHaveLength(0);
});
