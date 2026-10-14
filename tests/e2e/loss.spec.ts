import { expect, test, expectConsoleError } from './support/fixtures';

// The loss notice is the page's answer to a GPU that disappears mid-session. WEBGL_lose_context exists
// on WebGL only, so this check runs in the webgl2 project. It deliberately loses the device while the
// Scene reveal veil is frozen black: that is the hard case in which both the lobby retry and page-level
// Reload recovery must remain operable without exposing an unready scene.
test('fails closed and keeps reload recovery operable when WebGL is lost during black-hold', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgl2', 'WEBGL_lose_context is a WebGL extension');

  await page.goto('/?webgl=1&e2e=1&gate=on&freeze=black-hold');
  const lobby = page.locator('#entry-lobby');
  const veil = page.locator('#scene-veil');
  const canvas = page.locator('canvas#scene');
  await lobby.locator('#lobby-load-btn').click();
  await expect(canvas).toHaveAttribute('data-backend', 'webgl2', { timeout: 60_000 });
  await expect(veil).toHaveAttribute('data-state', 'black-hold', { timeout: 60_000 });

  expectConsoleError(page, /^THREE\.THREE\.WebGPURenderer: WebGL Device Lost:/,
    'WEBGL_lose_context deliberately loses the renderer while the reveal is black');
  expectConsoleError(page, /^\[archviz\] transition error The graphics device was lost\. Reload to restore the showroom\.$/,
    'the frozen reveal reports the deliberately lost device while showing recovery');
  await page.evaluate(() => {
    const scene = document.querySelector('canvas#scene');
    const context = scene instanceof HTMLCanvasElement ? scene.getContext('webgl2') : null;
    const extension = context?.getExtension('WEBGL_lose_context');
    if (!extension) {
      throw new Error('WEBGL_lose_context is not available on the page canvas');
    }
    extension.loseContext();
  });

  const notice = page.locator('[role="alert"]');
  await expect(notice).toHaveCount(1);
  const reload = notice.getByRole('button', { name: 'Reload' });
  await expect(reload).toBeVisible();
  await expect(lobby).toHaveAttribute('data-state', 'error');
  await expect(veil).toBeHidden();
  await expect(lobby.getByRole('button', { name: 'RETRY LOADING' })).toBeVisible();

  // The page-level Reload is the supported device-loss recovery. Prove it is clickable even while
  // the formerly-black transition surface has failed closed, then prove the fresh page returns to
  // the entry lobby rather than exposing a dead scene.
  const navigated = page.waitForEvent('framenavigated');
  await reload.click();
  await navigated;
  await expect(page.locator('#entry-lobby')).toHaveAttribute('data-state', 'idle');
});
