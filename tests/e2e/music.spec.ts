import { browserReports, expect, expectConsoleError, test } from './support/fixtures';
import type { Page } from '@playwright/test';
import { backendPath } from './support/backend';
import { openShowroom } from './support/showroom';

// The music switch in the header on both backends. Both projects default to headless and muted
// output; the WebGPU project also explicitly supplies --mute-audio. A Playwright click is a trusted
// gesture, which unlocks the AudioContext even while browser output is muted.

const PLAYING_TIMEOUT = 15_000;
// The content set is about 35 MB before the scene is ready, the same wait the smoke suite uses.
const SCENE_READY_TIMEOUT = 60_000;
// The audio-clock polls wait for the loop position itself, so the budget covers fetch, decode and
// start, the same wait as becoming playing, and never assumes wall time equals play time.
const PROGRESS_TIMEOUT = 15_000;
// One second of loop position proves the decoded source drives the clock.
const INITIAL_PROGRESS_S = 1;
// The pause tolerance is unchanged: the in-page gap between the pointerdown capture and the
// synchronous freeze in the click handler is a few milliseconds, so 0.6 s no longer has to hide
// protocol round-trip latency.
const PAUSE_LATENCY_S = 0.6;
// A deliberate interval the frozen position must survive unchanged: while the source runs, the
// loop position advances one audio second per wall second, the same span the progress polls read
// as proof the clock runs, so a freeze that did not happen moves the reading inside this window.
const PAUSE_OBSERVE_MS = 1_000;
// The unique prefix of the one console line the init script in the arming case reports the page's
// first music decision on. Nothing else logs it, so the wait cannot catch a foreign line, and its
// type is log, which the browser error guard treats as ordinary output.
const FIRST_DECISION_PREFIX = '[archviz-e2e] first music decision: ';
// The decision happens once the entry bundle has run, before any content fetch, so the wait covers
// downloading and evaluating the bundle, not the scene behind it.
const FIRST_DECISION_TIMEOUT = 30_000;

function switchButton(page: Page) {
  return page.locator('header button.music-switch');
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

test('starts on the switch, stops on it, and remembers the stop', async ({ page, request }) => {
  // Two scene loads in one test, the second one warm: the file's own budget, not the config's.
  test.setTimeout(90_000);
  const musicRequests = watchMusicRequests(page);
  await openShowroom(page, request, '/?e2e=1&music=off');
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
  await openShowroom(page, request, '/?e2e=1');
  await expect(button).toHaveAttribute('data-music', 'off');
  await expect(button).toHaveAttribute('aria-pressed', 'false');
  expect(musicRequests.seen(), 'the remembered stop fetches nothing either').toEqual([]);
});

test('arms until the first gesture anywhere on the page', async ({ page }) => {
  const musicRequests = watchMusicRequests(page);
  // Every Playwright call into the page counts as the visitor's gesture: the page records
  // navigator.userActivation.hasBeenActive false at load and it turns true at the first such call,
  // a locator poll, an expect poll or an evaluate, in the bundled Chromium and in the installed
  // Chrome alike. A poll of the switch right after goto therefore races the page's own first
  // play() decision and can read "playing" from the very gesture the test supplied. So the case
  // observes the decision from outside the page: an init script records every value the switch's
  // data-music attribute takes, in order, from before the page's own scripts run, and reports the
  // first decided value through one console line; waitForEvent reads that line as a browser event
  // and calls nothing in the page, so the decision arrives untouched by the test.
  const firstDecision = page.waitForEvent('console', {
    predicate: (message) => message.text().startsWith(FIRST_DECISION_PREFIX),
    timeout: FIRST_DECISION_TIMEOUT,
  });
  await page.addInitScript((prefix: string) => {
    // The switch renders its mount state and then the page's first music decision, both inside
    // one script turn, so reading the attribute after the fact would only ever show the last of
    // the two. The mutation records' oldValue chain keeps every value in order, and the value
    // after the mount render is the first decision, the one this case asserts on.
    const values: string[] = [];
    const record = (value: string | null): void => {
      if (value === null || values[values.length - 1] === value) {
        return;
      }
      values.push(value);
      if (values.length === 2) {
        console.log(prefix + JSON.stringify({
          value: values[1], hasBeenActive: navigator.userActivation.hasBeenActive,
        }));
      }
    };
    const observer = new MutationObserver((records) => {
      for (const change of records) {
        if (change.type === 'attributes') {
          record(change.oldValue);
        }
      }
      const button = document.querySelector('header button.music-switch');
      record(button === null ? null : button.getAttribute('data-music'));
      if (values.length >= 2) {
        // The first decision is all the case reads; stop following the page's DOM.
        observer.disconnect();
      }
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['data-music'],
    });
  }, FIRST_DECISION_PREFIX);
  await page.goto(backendPath('/?e2e=1'));
  const decision: unknown = JSON.parse((await firstDecision).text().slice(FIRST_DECISION_PREFIX.length));
  expect(decision, 'the page decides to arm before any gesture').toEqual({
    value: 'armed', hasBeenActive: false,
  });
  expect(musicRequests.seen(), 'armed fetches nothing until the gesture').toEqual([]);

  // A click on the canvas, not on the switch: the first gesture is the page's, wherever it lands.
  const button = switchButton(page);
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
});

test('keeps the position across a pause and a resume', async ({ page, request }) => {
  await openShowroom(page, request, '/?e2e=1&music=off');
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

  // Prerequisite: the decoded source actually plays. The audio clock is polled past one second of
  // the loop instead of a fixed wait that assumes a wall-clock second is a second of audio.
  await expect
    .poll(readPosition, {
      message: 'the audio clock advances past one second of the loop',
      timeout: PROGRESS_TIMEOUT,
    })
    .toBeGreaterThan(INITIAL_PROGRESS_S);
  const p1 = await readPosition();

  // Record the audio clock inside the page at the pause click itself: a window capture listener
  // runs before the switch's own click handler, and pause() freezes the position synchronously in
  // that handler, so this reading brackets the same dispatch the freeze belongs to.
  await page.evaluate(() => {
    const hooks = window.archvizMusic;
    if (hooks === undefined) {
      throw new Error('the music e2e hook is missing');
    }
    window.addEventListener(
      'pointerdown',
      () => {
        document.documentElement.dataset.musicPauseClickPosition = String(hooks.position());
      },
      { once: true, capture: true },
    );
  });

  await button.click();
  await expect(button).toHaveAttribute('data-music', 'off');
  const clickReading = await page.getAttribute('html', 'data-music-pause-click-position');
  expect(clickReading, 'the pause click was captured inside the page').not.toBeNull();
  const clickPosition = Number(clickReading);
  const p2 = await readPosition();
  expect(p2, 'the frozen reading is not before the pause').toBeGreaterThanOrEqual(p1);
  expect(p2, 'the frozen reading is not before the click reading').toBeGreaterThanOrEqual(clickPosition);
  // The freeze happens at the click, not at the end of the 0.4 s fade; the tolerance is unchanged
  // and now covers only the in-page gap between the capture and the freeze.
  expect(p2, 'the frozen reading is within the click latency').toBeLessThan(clickPosition + PAUSE_LATENCY_S);
  // Prerequisite: a deliberate interval the freeze must survive. A source that kept running would
  // move the reading past the frozen value inside it.
  await page.waitForTimeout(PAUSE_OBSERVE_MS);
  expect(await readPosition(), 'the position stays frozen through the pause').toBe(p2);

  await button.click();
  // Prerequisites: the resumed source really plays, then the audio clock itself passes the frozen
  // value, instead of a fixed wait assuming wall time equals play time.
  await expect(button).toHaveAttribute('data-music', 'playing', { timeout: PLAYING_TIMEOUT });
  await expect
    .poll(readPosition, {
      message: 'the resume continues past the frozen position',
      timeout: PROGRESS_TIMEOUT,
    })
    .toBeGreaterThan(p2);
});

test('reports a failed load as Music unavailable, the cause only in the console', async ({
  page,
  request,
}) => {
  // Cutting the manifest request is the same class of failure as a 404 or an undecodable file:
  // play() rejects and the switch lands in error. No audio output is needed, so the case runs on
  // both backends.
  await page.route('**/content/music/music.json', (route) => route.abort());
  await openShowroom(page, request, '/?e2e=1&music=off');
  const button = switchButton(page);
  await expect(button).toHaveAttribute('data-music', 'off');

  // Chromium reports the cut request as a console error whose text carries no URL, so the
  // pattern anchors on the reported text; the route above is what ties the error to the
  // manifest, the one request this case fails. The guard ignores plain warnings, so the
  // [archviz] diagnosis warning needs no declaration.
  expectConsoleError(page, /^Failed to load resource: net::ERR_FAILED/,
    'the route abort is a deliberate network failure: the cut manifest behind the error state');
  await button.click();
  await expect(button).toHaveAttribute('data-music', 'error', { timeout: PLAYING_TIMEOUT });
  await expect(button.locator('span')).toHaveText('Music unavailable');
  // The focus tooltip carries the fixed text too, never the browser's raw rejection message.
  await expect(button).toHaveAttribute('data-tooltip', 'Music unavailable');
  // The raw cause stays diagnosable: one warning under the [archviz] prefix.
  await expect
    .poll(
      () =>
        browserReports(page).some(
          (report) =>
            report.kind === 'console' &&
            report.type === 'warning' &&
            report.text.startsWith('[archviz] music'),
        ),
      { message: 'the raw cause was warned under the [archviz] prefix' },
    )
    .toBe(true);
});
