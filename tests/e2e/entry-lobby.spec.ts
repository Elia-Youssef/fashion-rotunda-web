import { expect, test } from './support/fixtures';
import type { Page } from '@playwright/test';

import { backendPath, projectBackend } from './support/backend';
import { holdFirstRequest } from './support/held-request';
import { waitForSceneInitialization } from './support/ready';

// Entry lobby E2E verification: the deferred boot contract, zero network activity before the
// user gesture, responsive viewports, focus containment, hit-test blocking and music
// preferences. The cases that press the load control and read the boot that follows run on both
// projects, each opening through backendPath and pinning canvas[data-backend] to the project's
// backend right after the press, so a silent fallback fails the run. The cases whose every
// reading ends before the press stay on the WebGL 2 project: no renderer exists until the press
// (main() parks at lobby.waitForLoadRequest()), so the webgpu project would repeat the same run.

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'landscape', width: 844, height: 390 },
] as const;

// The final scene hook mounts after the reveal, so it is the initialized state the after-boot
// checks observe; the budget is the same one the reveal waits in this file share.
const INITIALIZED_TIMEOUT = 60_000;

// The backend pin's budget: the load action creates the renderer (src/renderer/create.ts
// publishes canvas[data-backend] once it initializes), and on the software WebGL 2 project under
// the configured workers that creation can outlast the five-second assertion default.
const BACKEND_PIN_TIMEOUT = 60_000;

// The press is the first moment the backends can differ: pin the canvas to the project's own
// backend before any reading that follows the press, so a silent fallback fails the run there.
async function expectProjectBackendAfterLoad(page: Page): Promise<void> {
  await expect(page.locator('canvas#scene')).toHaveAttribute('data-backend', projectBackend(), {
    timeout: BACKEND_PIN_TIMEOUT,
  });
}

// The held half-set rotunda keeps the touch Base load observable; 30 s covers a slow boot start
// under four software workers, the same budget the loading spec's hold uses.
const HALF_ROTUNDA_HOLD_TIMEOUT_MS = 30_000;

// The pre-gesture absence window: after the lobby publishes idle, a premature fetch has this
// long to appear in the request watcher before the zero-request reading. Absence is only
// provable by wall time, so the length is kept; the anchor decides where it starts.
const PRE_GESTURE_QUIET_WINDOW_MS = 1_000;

// Cases whose every reading ends before the load action stay on the WebGL 2 project: main()
// parks at lobby.waitForLoadRequest() until that press and creates the renderer only after it,
// so no reading they take can see the backend and the webgpu project would repeat the same run.
function skipWhenNoReadingFollowsTheLoadAction(): void {
  test.skip(
    test.info().project.name !== 'webgl2',
    'every reading ends before the load action, when no renderer exists, so the webgpu project would repeat the same run',
  );
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

test('releases page keyboard navigation after the lobby reveal', async ({ page }) => {
  const backend = test.info().project.name === 'webgpu' ? 'webgpu' : 'webgl2';
  const params = new URLSearchParams({ e2e: '1', gate: 'on', music: 'off' });
  if (backend === 'webgl2') params.set('webgl', '1');
  await page.goto(`/?${params.toString()}`);
  const lobby = page.locator('#entry-lobby');
  await expect(lobby).toHaveAttribute('data-state', 'idle');
  await lobby.locator('#lobby-load-btn').click();
  await expect(lobby).toHaveAttribute('data-state', 'revealed', { timeout: 60_000 });
  await expect(lobby).toBeHidden();
  await expect(page.locator('canvas#scene')).toHaveAttribute('data-backend', backend);

  // The reveal hands focus to main. Tab must reach a real page control without cancellation.
  const main = page.locator('main');
  await main.focus();
  await expect(main).toBeFocused();
  await page.evaluate(() => {
    document.documentElement.removeAttribute('data-tab-prevented');
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        document.documentElement.dataset.tabPrevented = String(event.defaultPrevented);
      }
    }, { once: true });
  });
  await page.keyboard.press('Tab');
  await expect(page.locator('html')).toHaveAttribute('data-tab-prevented', 'false');
  const focus = await page.evaluate(() => {
    const active = document.activeElement;
    return {
      isPageControl: active !== null && active.matches('button, input, select, textarea, a[href], canvas[tabindex="0"]'),
      outsideLobby: active !== null && active.closest('#entry-lobby') === null,
      available: active !== null && active.closest('[inert], [hidden], [aria-hidden="true"]') === null,
    };
  });
  expect(focus).toEqual({ isPageControl: true, outsideLobby: true, available: true });
});

test('proves deferred load: zero /content/ or music requests before user gesture', async ({ page }) => {
  const watcher = watchRequests(page);

  // freeze=ready-hidden holds the intermediate lobby phase at the test seam, so the ready-hidden
  // assertion below observes the phase itself instead of racing its automatic 250 ms advance.
  await page.goto(backendPath('/?e2e=1&gate=on&freeze=ready-hidden'));
  const lobby = page.locator('#entry-lobby');
  await expect(lobby).toHaveAttribute('data-state', 'idle');

  // The markup ships idle, so the attribute above cannot prove the app is alive: the window is
  // anchored on the state the mounted lobby publishes instead (dev and ?e2e=1 builds), so a
  // boot that never mounts fails here rather than leaving the window running without an app.
  await expect
    .poll(() => page.evaluate(() => window.archvizLobby?.state ?? null), {
      message: 'the mounted lobby publishes its idle state',
    })
    .toBe('idle');

  // Let any potential premature timers fire: the window is measured from the published idle
  // state, and nothing runs between the anchor and the window, so it keeps its full length.
  await page.waitForTimeout(PRE_GESTURE_QUIET_WINDOW_MS);

  // Assert: ZERO /content/ and ZERO music requests made
  expect(watcher.contentUrls(), 'zero content requests before click').toEqual([]);
  expect(watcher.musicUrls(), 'zero music requests before click').toEqual([]);

  // Canvas must remain completely uninitialized (no data-scene attribute)
  const canvas = page.locator('canvas#scene');
  expect(await canvas.getAttribute('data-scene')).toBeNull();

  // Click Load Experience
  const loadBtn = lobby.locator('#lobby-load-btn');
  await loadBtn.click();

  await expectProjectBackendAfterLoad(page);

  // Now requests must begin
  await expect
    .poll(() => watcher.contentUrls().length, { message: 'content requests start after click' })
    .toBeGreaterThan(0);

  // Wait for ready-hidden
  await expect(lobby).toHaveAttribute('data-state', 'ready-hidden', { timeout: 60_000 });
  await expect(canvas).toHaveAttribute('data-scene', 'ready');
});

test('proves hit-test blocking: underlying shell cannot receive pointer events', async ({ page }) => {
  skipWhenNoReadingFollowsTheLoadAction();

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
  skipWhenNoReadingFollowsTheLoadAction();

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
  const watcher = watchRequests(page);

  // freeze=ready-hidden holds the intermediate lobby phase at the test seam; after the assertion
  // below the unfreeze lets the boot run on to the real revealed and initialized state.
  await page.goto(backendPath('/?e2e=1&gate=on&freeze=ready-hidden'));
  const lobby = page.locator('#entry-lobby');
  const musicSwitch = lobby.locator('.entry-lobby__music-switch');

  // Toggle to off
  await musicSwitch.click();
  await expect(musicSwitch).toHaveAttribute('data-music', 'off');

  // Click Load Experience
  const loadBtn = lobby.locator('#lobby-load-btn');
  await loadBtn.click();

  await expectProjectBackendAfterLoad(page);

  // The held phase: ready-hidden stays observable until the test releases it.
  await expect(lobby).toHaveAttribute('data-state', 'ready-hidden', { timeout: 60_000 });
  await page.evaluate(() => window.archvizTransitionSeam?.unfreeze());

  // The zero-audio reading observes the actual end of boot, not a fixed delay after ready-hidden:
  // the watcher accumulates every request since the goto, so one reading at the initialized state
  // covers during and after the boot, however long the boot takes.
  await expect(lobby).toHaveAttribute('data-state', 'revealed', { timeout: 60_000 });
  await waitForSceneInitialization(page, INITIALIZED_TIMEOUT);

  expect(watcher.musicUrls(), 'music=off resulted in zero audio requests').toEqual([]);

  // Check stored preference
  const stored = await page.evaluate(() => localStorage.getItem('fashion-rotunda.music'));
  expect(stored).toBe('off');
});

test('safe area insets do not clip interactive controls', async ({ page }) => {
  skipWhenNoReadingFollowsTheLoadAction();

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

// A touch device lands on the Base tier, whose asset set is the half set. The lobby's tracker must
// follow /content/half, so the bar moves while the load is still running and every scene geometry
// request goes to the half set.
test.describe('lobby progress on the touch half set', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
  });

  test('tracks the half set a touch Base device loads: the bar rises before ready', async ({ page }) => {
    // The held half-set rotunda keeps the lobby in its loading phase while the other tracked files
    // arrive, so the bar has a window in which a real rise is observable.
    const rotunda = await holdFirstRequest(page, '**/content/half/rotunda.glb', HALF_ROTUNDA_HOLD_TIMEOUT_MS);
    const glbPaths: string[] = [];
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.endsWith('.glb')) glbPaths.push(pathname);
    });

    await page.goto(backendPath('/?e2e=1&gate=on&tier=base&music=off'));
    const lobby = page.locator('#entry-lobby');
    await expect(lobby).toHaveAttribute('data-state', 'idle');
    await lobby.locator('#lobby-load-btn').click();

    await expectProjectBackendAfterLoad(page);
    await expect(lobby).toHaveAttribute('data-state', 'loading');
    await rotunda.waitUntilEntered();

    const progress = lobby.locator('.entry-lobby__progress-bar');
    await expect
      .poll(async () => Number((await progress.getAttribute('value')) ?? '0'), {
        message: 'the bar rises above zero while the lobby is still loading',
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    expect(
      await lobby.getAttribute('data-state'),
      'the held rotunda keeps the lobby in its loading phase',
    ).toBe('loading');

    await rotunda.release();
    await rotunda.waitUntilContinued();
    await expect(lobby).toHaveAttribute('data-state', 'revealed', { timeout: 60_000 });

    expect(glbPaths.length, 'the scene geometry was requested').toBeGreaterThan(0);
    for (const pathname of glbPaths) {
      expect(pathname, `${pathname} is served from the half set`).toMatch(/^\/content\/half\//);
    }
  });
});

// A ?look= deep link names the look the page loads first, and the lobby's tracker must count
// that same look. While the rotunda request is held the tracker owns the readout and the status
// text, so the readout's total is checked against the shipped manifest there. The bar after the
// release cannot prove the count: setReady forces the bar to 1 whatever the tracker counted.
test('counts the deep-linked look: the bar rises and reaches its total', async ({ page, request }) => {
  // The same files the tracker counts: rotunda, plinth and the deep-linked look, no environment
  // under the default sky. The deep-linked look and the first look differ by about 1 MB, so a
  // tracker that counted the wrong look would publish a different readout total.
  const catalog = (await (await request.get('/content/catalog.json')).json()) as {
    rotunda: { file: string };
    plinth: { file: string };
    looks: Array<{ id: string; file: string }>;
  };
  const manifest = (await (await request.get('/content/manifest.json')).json()) as {
    sets: { full: { files: Record<string, { bytes: number }> } };
  };
  const manifestFiles = manifest.sets.full.files;
  const linked = catalog.looks.find((look) => look.id === 'zoot-suit');
  if (linked === undefined) {
    throw new Error('the shipped catalogue has no look zoot-suit');
  }
  const expectedBytes =
    manifestFiles[catalog.rotunda.file].bytes +
    manifestFiles[catalog.plinth.file].bytes +
    manifestFiles[linked.file].bytes;
  const expectedTotal = new RegExp(
    `^\\d+\\.\\d+ MB of ${(expectedBytes / 1_000_000).toFixed(1).replace('.', '\\.')} MB$`,
  );

  // The held rotunda keeps the lobby in its loading phase while the other tracked files arrive,
  // so the bar has a window in which a real rise is observable.
  const rotunda = await holdFirstRequest(page, '**/content/rotunda.glb', HALF_ROTUNDA_HOLD_TIMEOUT_MS);
  const glbPaths: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('.glb')) glbPaths.push(pathname);
  });

  await page.goto(backendPath('/?e2e=1&gate=on&music=off&look=zoot-suit'));
  const lobby = page.locator('#entry-lobby');
  await expect(lobby).toHaveAttribute('data-state', 'idle');
  await lobby.locator('#lobby-load-btn').click();

  await expectProjectBackendAfterLoad(page);
  await expect(lobby).toHaveAttribute('data-state', 'loading');
  await rotunda.waitUntilEntered();

  // While the lobby is still loading, the tracker publishes the readout total and the status
  // count: the total must be the deep-linked look's share of the manifest, formatted the way
  // formatProgress formats it, and the count the three tracked files.
  const readout = lobby.locator('.entry-lobby__progress-readout');
  await expect
    .poll(async () => (await readout.textContent()) ?? '', {
      message: `the readout total is the deep-linked look total (${(expectedBytes / 1_000_000).toFixed(1)} MB)`,
      timeout: 20_000,
    })
    .toMatch(expectedTotal);
  await expect
    .poll(async () => (await lobby.locator('.entry-lobby__status').textContent()) ?? '', {
      message: 'the status publishes the three tracked files while the load runs',
      timeout: 20_000,
    })
    .toMatch(/ of 3 files$/);

  const progress = lobby.locator('.entry-lobby__progress-bar');
  await expect
    .poll(async () => Number((await progress.getAttribute('value')) ?? '0'), {
      message: 'the bar rises above zero while the lobby is still loading',
      timeout: 20_000,
    })
    .toBeGreaterThan(0);
  expect(
    await lobby.getAttribute('data-state'),
    'the held rotunda keeps the lobby in its loading phase',
  ).toBe('loading');

  await rotunda.release();
  await rotunda.waitUntilContinued();

  await expect
    .poll(async () => Number((await progress.getAttribute('value')) ?? '0'), {
      message: 'the bar reaches the deep-linked look total',
      timeout: 60_000,
    })
    .toBe(1);
  await expect(lobby).toHaveAttribute('data-state', 'revealed', { timeout: 60_000 });

  expect(glbPaths, 'the deep-linked look was requested').toContain('/content/looks/zoot-suit.glb');
});
