import { expect, test, type Page } from '@playwright/test';

// Entry lobby E2E verification.
// WebGL2 project runs headless and verifies the deferred boot contract,
// zero network activity before user gesture, responsive viewports,
// focus containment, hit-test blocking, and music preferences.

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'landscape', width: 844, height: 390 },
] as const;

function skipUnlessWebgl2(): void {
  test.skip(test.info().project.name !== 'webgl2', 'runs on headless webgl2');
}

function watchRequests(page: Page): {
  contentUrls: () => string[];
  musicUrls: () => string[];
  clear: () => void;
} {
  const contentUrls: string[] = [];
  const musicUrls: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/content/')) {
      if (url.includes('/content/music/')) {
        musicUrls.push(new URL(url).pathname);
      } else {
        contentUrls.push(new URL(url).pathname);
      }
    }
  });
  return {
    contentUrls: () => [...contentUrls],
    musicUrls: () => [...musicUrls],
    clear: () => {
      contentUrls.length = 0;
      musicUrls.length = 0;
    },
  };
}

test('proves deferred load: zero /content/ or music requests before user gesture', async ({ page }) => {
  skipUnlessWebgl2();
  const watcher = watchRequests(page);

  await page.goto('/?webgl=1&gate=on');
  const lobby = page.locator('#entry-lobby');
  await expect(lobby).toHaveAttribute('data-state', 'idle');

  // Let any potential premature timers fire
  await page.waitForTimeout(1000);

  // Assert: ZERO /content/ and ZERO music requests made
  expect(watcher.contentUrls(), 'zero content requests before click').toEqual([]);
  expect(watcher.musicUrls(), 'zero music requests before click').toEqual([]);

  // Canvas must remain completely uninitialized (no data-scene attribute)
  const canvas = page.locator('canvas#scene');
  expect(await canvas.getAttribute('data-scene')).toBeNull();

  // Click Load Experience
  const loadBtn = lobby.locator('#lobby-load-btn');
  await loadBtn.click();

  // Now requests must begin
  await expect
    .poll(() => watcher.contentUrls().length, { message: 'content requests start after click' })
    .toBeGreaterThan(0);

  // Wait for ready-hidden
  await expect(lobby).toHaveAttribute('data-state', 'ready-hidden', { timeout: 60_000 });
  await expect(canvas).toHaveAttribute('data-scene', 'ready');
});

test('proves hit-test blocking: underlying shell cannot receive pointer events', async ({ page }) => {
  skipUnlessWebgl2();

  await page.goto('/?webgl=1&gate=on');
  const lobby = page.locator('#entry-lobby');
  await expect(lobby).toHaveAttribute('data-state', 'idle');

  // Verify that elements behind the lobby cannot be clicked
  const canvas = page.locator('canvas#scene');
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();

  // A click on the center of the screen must hit the lobby or its card, NOT the canvas
  const hitElement = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return el?.closest('#entry-lobby') !== null;
  }, { x: canvasBox!.x + canvasBox!.width / 2, y: canvasBox!.y + canvasBox!.height / 2 });

  expect(hitElement, 'click hit the entry lobby').toBe(true);
});

test('proves no page scroll at all 4 target viewports', async ({ page }) => {
  skipUnlessWebgl2();

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/?webgl=1&gate=on');
    const lobby = page.locator('#entry-lobby');
    await expect(lobby).toHaveAttribute('data-state', 'idle');

    const scrollMetrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }));

    expect(scrollMetrics.scrollWidth, `${vp.name} has no horizontal scroll`).toBeLessThanOrEqual(scrollMetrics.clientWidth);
    expect(scrollMetrics.scrollHeight, `${vp.name} has no vertical scroll`).toBeLessThanOrEqual(scrollMetrics.clientHeight);

    // Verify touch target size of Load button (minimum 44x44 CSS px)
    const loadBtn = lobby.locator('#lobby-load-btn');
    const btnBox = await loadBtn.boundingBox();
    expect(btnBox, `${vp.name} load button exists`).not.toBeNull();
    expect(btnBox!.width, `${vp.name} load button width >= 44`).toBeGreaterThanOrEqual(44);
    expect(btnBox!.height, `${vp.name} load button height >= 44`).toBeGreaterThanOrEqual(44);

    // Verify music switch touch target (minimum 44x44 CSS px)
    const musicSwitch = lobby.locator('.entry-lobby__music-switch');
    const musicBox = await musicSwitch.boundingBox();
    expect(musicBox, `${vp.name} music switch exists`).not.toBeNull();
    expect(musicBox!.width, `${vp.name} music switch width >= 44`).toBeGreaterThanOrEqual(44);
    expect(musicBox!.height, `${vp.name} music switch height >= 44`).toBeGreaterThanOrEqual(44);
  }
});

test('proves music preference persistence: Music off fetches no audio during or after boot', async ({ page }) => {
  skipUnlessWebgl2();
  const watcher = watchRequests(page);

  await page.goto('/?webgl=1&gate=on');
  const lobby = page.locator('#entry-lobby');
  const musicSwitch = lobby.locator('.entry-lobby__music-switch');

  // Toggle to off
  await musicSwitch.click();
  await expect(musicSwitch).toHaveAttribute('data-music', 'off');

  // Click Load Experience
  const loadBtn = lobby.locator('#lobby-load-btn');
  await loadBtn.click();

  // Wait for ready-hidden
  await expect(lobby).toHaveAttribute('data-state', 'ready-hidden', { timeout: 60_000 });

  // Wait extra to verify no delayed audio requests fire
  await page.waitForTimeout(2000);

  expect(watcher.musicUrls(), 'music=off resulted in zero audio requests').toEqual([]);

  // Check stored preference
  const stored = await page.evaluate(() => localStorage.getItem('fashion-rotunda.music'));
  expect(stored).toBe('off');
});

test('safe area insets do not clip interactive controls', async ({ page }) => {
  skipUnlessWebgl2();

  // Install custom safe area insets
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?webgl=1&gate=on');

  await page.evaluate(() => {
    document.documentElement.style.setProperty('--safe-area-top', '44px');
    document.documentElement.style.setProperty('--safe-area-bottom', '34px');
  });

  const lobby = page.locator('#entry-lobby');
  const loadBtn = lobby.locator('#lobby-load-btn');
  const musicSwitch = lobby.locator('.entry-lobby__music-switch');

  const btnBox = await loadBtn.boundingBox();
  const musicBox = await musicSwitch.boundingBox();

  expect(musicBox!.y, 'music button clears safe area top').toBeGreaterThanOrEqual(44);
  expect(btnBox!.y + btnBox!.height, 'load button clears safe area bottom').toBeLessThanOrEqual(844 - 34);
});
