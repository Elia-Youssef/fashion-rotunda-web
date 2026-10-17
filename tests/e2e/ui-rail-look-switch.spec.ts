import { expect, test } from './support/fixtures';
import { SCENE_READY_TIMEOUT, waitForLoopIdle, waitForSceneInitialization } from './support/ready';
import { openShowroom } from './support/showroom';
import { holdFirstRequest } from './support/held-request';
import { RAIL_PATH } from './support/catalogue-rail';

const SWITCH_TIMEOUT = 30_000;
// The click marks its own button busy synchronously in selectLook (strip.setBusy before the look
// fetch starts, src/ui/chrome.ts), so the wait covers only the click dispatch itself; 5 s is
// headroom for a loaded machine, not a matched budget.
const BUSY_MARK_TIMEOUT_MS = 5000;

test.describe('Catalogue Rail Parity', () => {
  test('selection via pointer, Enter, Space, and focus continuity across breakpoints', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { canvas } = await openShowroom(page, request, RAIL_PATH);

    const rail = page.locator('#looks');
    const buttons = rail.locator('button');

    // 1. Pointer selection
    await buttons.nth(1).click();
    await expect(canvas).toHaveAttribute('data-look', 'zoot-suit', { timeout: SWITCH_TIMEOUT });
    await expect(buttons.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(buttons.nth(0)).not.toHaveAttribute('aria-current');

    // 2. Keyboard Enter selection
    await buttons.nth(2).focus();
    await page.keyboard.press('Enter');
    await expect(canvas).toHaveAttribute('data-look', 'new-look-dress', { timeout: SWITCH_TIMEOUT });
    await expect(buttons.nth(2)).toHaveAttribute('aria-current', 'true');
    await expect(buttons.nth(1)).not.toHaveAttribute('aria-current');

    // 3. Keyboard Space selection
    await buttons.nth(3).focus();
    await page.keyboard.press('Space');
    await expect(canvas).toHaveAttribute('data-look', 'mondrian-dress', { timeout: SWITCH_TIMEOUT });
    await expect(buttons.nth(3)).toHaveAttribute('aria-current', 'true');
    await expect(buttons.nth(2)).not.toHaveAttribute('aria-current');

    // 4. Focus continuity across desktop <-> tablet resize in both directions
    await buttons.nth(4).focus();
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.look)).toBe(
      'jumpsuit-dress',
    );

    // Resize to tablet
    await page.setViewportSize({ width: 820, height: 1180 });
    expect(
      await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.look),
      'focus preserved after resize to tablet',
    ).toBe('jumpsuit-dress');

    // Resize back to desktop
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(
      await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.look),
      'focus preserved after resize back to desktop',
    ).toBe('jumpsuit-dress');
  });

  test('latest-click-wins race condition with deterministic route delay', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { canvas } = await openShowroom(page, request, RAIL_PATH);

    const rail = page.locator('#looks');
    const btnJumpsuit = rail.locator('button[data-look="jumpsuit-dress"]');
    const btnBlueSilk = rail.locator('button[data-look="blue-silk-dress"]');

    await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);
    const startId = await canvas.getAttribute('data-look');
    expect(startId, 'the starting look is published').not.toBeNull();
    const memoryBefore = await canvas.getAttribute('data-memory');
    expect(memoryBefore, 'the initialized memory baseline is published').not.toBeNull();
    const hold = await holdFirstRequest(page, '**/content/looks/jumpsuit-dress.glb', SWITCH_TIMEOUT);
    try {
      await btnJumpsuit.click();
      await hold.waitUntilEntered();
      // Wait for the held request's busy state before superseding it.
      await expect(btnJumpsuit).toHaveAttribute('aria-busy', 'true', { timeout: SWITCH_TIMEOUT });
      await btnBlueSilk.click();
    } finally {
      hold.release();
    }
    await hold.waitUntilContinued();

    // The winning look must be blue silk dress
    await expect(canvas).toHaveAttribute('data-look', 'blue-silk-dress', { timeout: SWITCH_TIMEOUT });
    await expect(page.locator('.product-card h2')).toHaveText('Blue Silk Dress');
    await expect(btnBlueSilk).toHaveAttribute('aria-current', 'true');
    await expect(btnJumpsuit).not.toHaveAttribute('aria-current');

    // No buttons remain busy
    await expect(rail.locator('[aria-busy="true"]')).toHaveCount(0);
    // Return to the same initialized look so leaked loser resources change the live GPU count.
    await rail.locator(`button[data-look="${String(startId)}"]`).click();
    await expect(canvas).toHaveAttribute('data-look', String(startId), { timeout: SWITCH_TIMEOUT });
    await expect(canvas).toHaveAttribute('data-fade', '0', { timeout: SWITCH_TIMEOUT });
    // Wait for the disposal draw to publish the original resource count.
    await expect(canvas).toHaveAttribute('data-memory', String(memoryBefore), { timeout: SWITCH_TIMEOUT });

    await page.unroute('**/content/looks/jumpsuit-dress.glb');
  });

  test('controlled pending and busy state capture and semantic reading', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openShowroom(page, request, RAIL_PATH);

    const rail = page.locator('#looks');
    const targetBtn = rail.locator('button[data-look="new-look-dress"]');

    let resumeRoute: (() => void) | null = null;
    const routePromise = new Promise<void>((resolve) => {
      resumeRoute = resolve;
    });

    await page.route('**/content/looks/new-look-dress.glb', async (route) => {
      await routePromise;
      await route.continue();
    });

    // Click target to trigger pending switch
    await targetBtn.click();

    // Immediately verify aria-busy is set
    await expect(targetBtn).toHaveAttribute('aria-busy', 'true', { timeout: BUSY_MARK_TIMEOUT_MS });

    // Verify semantic readings of the busy state
    await expect.poll(async () => {
      return Number(await targetBtn.evaluate((el) => getComputedStyle(el).opacity));
    }).toBeCloseTo(0.6, 1);

    const busyReading = await targetBtn.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        ariaBusy: el.getAttribute('aria-busy'),
        cursor: style.cursor,
        ariaCurrent: el.getAttribute('aria-current'),
      };
    });

    expect(busyReading.ariaBusy).toBe('true');
    expect(busyReading.cursor).toBe('wait');

    // Release the route so it finishes loading
    if (resumeRoute !== null) {
      (resumeRoute as () => void)();
    }

    // Now it settles
    await expect(targetBtn).not.toHaveAttribute('aria-busy', { timeout: SWITCH_TIMEOUT });
    await expect(targetBtn).toHaveAttribute('aria-current', 'true');

    await page.unroute('**/content/looks/new-look-dress.glb');
  });

  test('renderer preservation and demand loop return to idle', async ({ page, request }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const { canvas } = await openShowroom(page, request, RAIL_PATH);

    await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);
    const initialMetrics = await page.evaluate(() => {
      const cv = document.querySelector<HTMLCanvasElement>('canvas#scene');
      const camera = window.archvizCamera;
      const hooks = window.archvizE2E;
      if (!cv || !camera || !hooks) throw new Error('handles unavailable');
      const rect = cv.getBoundingClientRect();
      const desc = hooks.describeScene();
      return {
        cssWidth: rect.width,
        cssHeight: rect.height,
        backingWidth: cv.width,
        backingHeight: cv.height,
        backend: cv.dataset.backend,
        cameraMode: camera.mode,
        meshes: desc.meshes,
      };
    });

    // Switch look to zoot-suit and back to wallis-dress
    const rail = page.locator('#looks');
    await rail.locator('button[data-look="zoot-suit"]').click();
    await expect(canvas).toHaveAttribute('data-look', 'zoot-suit', { timeout: SWITCH_TIMEOUT });

    await rail.locator('button[data-look="wallis-dress"]').click();
    await expect(canvas).toHaveAttribute('data-look', 'wallis-dress', { timeout: SWITCH_TIMEOUT });

    await waitForLoopIdle(page);

    const finalMetrics = await page.evaluate(() => {
      const cv = document.querySelector<HTMLCanvasElement>('canvas#scene');
      const camera = window.archvizCamera;
      const hooks = window.archvizE2E;
      if (!cv || !camera || !hooks) throw new Error('handles unavailable');
      const rect = cv.getBoundingClientRect();
      const desc = hooks.describeScene();
      return {
        cssWidth: rect.width,
        cssHeight: rect.height,
        backingWidth: cv.width,
        backingHeight: cv.height,
        backend: cv.dataset.backend,
        cameraMode: camera.mode,
        meshes: desc.meshes,
      };
    });

    expect(finalMetrics.cssWidth).toBe(initialMetrics.cssWidth);
    expect(finalMetrics.cssHeight).toBe(initialMetrics.cssHeight);
    expect(finalMetrics.backend).toBe(initialMetrics.backend);
    expect(finalMetrics.cameraMode).toBe(initialMetrics.cameraMode);
    expect(finalMetrics.meshes).toBe(initialMetrics.meshes);
  });
});
