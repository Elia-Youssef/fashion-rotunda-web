import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

// The music switch in the header. The webgl2 project only: it runs headless, and Playwright
// launches its Chromium with --mute-audio (playwright-core 1.63.0, lib/coreBundle.js line 43342,
// inside the `if (options.headless)` branch of _innerDefaultArgs), so nothing reaches the
// speakers. The headed WebGPU project has no such flag. A Playwright click is a trusted gesture,
// which is what unlocks the AudioContext.

function skipUnlessWebgl2(): void {
  test.skip(test.info().project.name !== 'webgl2', 'the headed project would play through the speakers');
}

const PLAYING_TIMEOUT = 15_000;
// The content set is about 35 MB before the scene is ready, the same wait the smoke suite uses.
const SCENE_READY_TIMEOUT = 60_000;

function switchButton(page: Page) {
  return page.locator('header button.music-switch');
}

async function openWithScene(page: Page, path: string) {
  await page.goto(path);
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  return canvas;
}

/** Every test ends on a clean console: no message of type error, the smoke suite's rule. */
function watchConsole(page: Page): () => void {
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => messages.push(message));
  return () => {
    const errors = messages.filter((message) => message.type() === 'error');
    expect(errors, 'no console messages of type error').toHaveLength(0);
  };
}

/**
 * Every request the page made for a music file or the manifest. "Music off" has to be free: not a
 * quiet page that fetched 1.2 MB of Opus anyway, which is what a switch wired to the gain alone
 * would give. clear() restarts the count so one test can assert it across a reload.
 */
function watchMusicRequests(page: Page): { seen: () => string[]; clear: () => void } {
  const urls: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/content/music/')) {
      urls.push(new URL(url).pathname);
    }
  });
  return {
    seen: () => [...urls],
    clear: () => {
      urls.length = 0;
    },
  };
}

test('starts on the switch, stops on it, and remembers the stop', async ({ page }) => {
  skipUnlessWebgl2();
  // Two scene loads in one test, the second one warm: the file's own budget, not the config's.
  test.setTimeout(90_000);
  const expectClean = watchConsole(page);
  const musicRequests = watchMusicRequests(page);
  await openWithScene(page, '/?webgl=1&e2e=1&music=off');
  const button = switchButton(page);

  await expect(button).toHaveAttribute('data-music', 'off');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  expect(musicRequests.seen(), 'music=off fetches nothing at all').toEqual([]);

  await button.click();
  await expect(button).toHaveAttribute('data-music', 'playing', { timeout: PLAYING_TIMEOUT });
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  // The other half of the zero-request assertions: the watcher does see requests when there are
  // any, and a start makes exactly two, the list and one file in one of the two formats.
  const started = musicRequests.seen();
  expect(started, 'the list and one file').toHaveLength(2);
  expect(started[0]).toBe('/content/music/music.json');
  expect(started[1]).toMatch(/\/content\/music\/music-01\.(ogg|m4a)$/);

  await button.click();
  await expect(button).toHaveAttribute('data-music', 'off');
  await expect(button).toHaveAttribute('aria-pressed', 'false');

  const stored = await page.evaluate(() => localStorage.getItem('fashion-rotunda.music'));
  expect(stored, 'the stop was stored').toBe('off');

  // Back without the music parameter, so the stored value is the only source left: the reload has
  // to come back off, and an off page is one that fetched no music.
  musicRequests.clear();
  await openWithScene(page, '/?webgl=1&e2e=1');
  await expect(button).toHaveAttribute('data-music', 'off');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  expect(musicRequests.seen(), 'the remembered stop fetches nothing either').toEqual([]);

  expectClean();
});

test('arms until the first gesture anywhere on the page', async ({ page }) => {
  skipUnlessWebgl2();
  const expectClean = watchConsole(page);
  const musicRequests = watchMusicRequests(page);
  await page.goto('/?webgl=1&e2e=1');
  const button = switchButton(page);
  await expect(button).toHaveAttribute('data-music', 'armed');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  expect(musicRequests.seen(), 'armed fetches nothing until the gesture').toEqual([]);

  // A click on the canvas, not on the switch: the first gesture is the page's, wherever it lands.
  const canvas = page.locator('canvas#scene');
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('the canvas has no bounding box');
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  // The click lands while the content set is still loading, as the entry gate's press does, so the
  // music list, the file and its decoding share the network and the main thread with the scene. In a
  // loaded software-rendered run that start outlasted PLAYING_TIMEOUT, so the music's own time limit
  // starts once the scene is ready.
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  await expect(button).toHaveAttribute('data-music', 'playing', { timeout: PLAYING_TIMEOUT });
  expectClean();
});

test('keeps the position across a pause and a resume', async ({ page }) => {
  skipUnlessWebgl2();
  const expectClean = watchConsole(page);
  await openWithScene(page, '/?webgl=1&e2e=1&music=off');
  const button = switchButton(page);
  await button.click();
  await expect(button).toHaveAttribute('data-music', 'playing', { timeout: PLAYING_TIMEOUT });

  const readPosition = () =>
    page.evaluate(() => {
      const hooks = window.archvizMusic;
      if (hooks === undefined) {
        throw new Error('the music e2e hook is missing');
      }
      return hooks.position();
    });

  await page.waitForTimeout(1500);
  const p1 = await readPosition();
  expect(p1, 'a second and a half in').toBeGreaterThan(1);

  await button.click();
  await expect(button).toHaveAttribute('data-music', 'off');
  await page.waitForTimeout(1000);
  const p2 = await readPosition();
  expect(p2, 'the frozen reading is not before the pause').toBeGreaterThanOrEqual(p1);
  // The freeze happens at the click, not at the end of the 0.4 s fade.
  expect(p2, 'the frozen reading is within the click latency of p1').toBeLessThan(p1 + 0.6);

  await button.click();
  await page.waitForTimeout(1000);
  const p3 = await readPosition();
  expect(p3, 'the resume continues from where it stopped').toBeGreaterThan(p2);
  expectClean();
});
