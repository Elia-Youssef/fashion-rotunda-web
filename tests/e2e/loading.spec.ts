import { BufferGeometry, Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

import { browserReports, expect, test, expectConsoleError } from './support/fixtures';

import { holdFirstRequest } from './support/held-request';
import { backendPath, projectBackend } from './support/backend';
import { STARTUP_FAILURE_MESSAGE } from '../../src/ui/startup-failure';
import { contentUrl, parseCatalog } from '../../src/catalog/catalog';

/** Follow the installed parser's material dependencies without downloading or decoding images. */
async function countBasisSources(bytes: ArrayBuffer): Promise<number> {
  const sources = new Set<number>();
  const ktx2 = new KTX2Loader();
  const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
  loader.register((parser) => {
    // Keep the real scene, node and material traversal. Variant-only materials stay deferred;
    // loadImageSource caches by source index, so samplers and repeated map references log once.
    parser.loadImageSource = async (sourceIndex, imageLoader) => {
      if (imageLoader === ktx2) sources.add(sourceIndex);
      return new Texture();
    };
    // Geometry does not choose material dependencies. Empty geometry avoids decoding the meshes
    // while retaining the loader's own material extension handling and image-source selection.
    parser.loadGeometries = async (primitives) => primitives.map(() => new BufferGeometry());
    return { name: 'count-basis-sources' };
  });
  await loader.parseAsync(bytes, '');
  return sources.size;
}

// Opaque entry lobby on a real load.
// Both backend projects run headless by default and activate the lobby through synthetic input.

// The held first rotunda request keeps the boot in loading until the test releases it, so the
// loading phase is observed while held; 30 s covers a slow boot start under four software workers.
const LOADING_HOLD_TIMEOUT_MS = 30_000;

// The progress poll waits for the whole first-load content set, the rotunda, the plinth and the
// first look (the HDR diagnostic joins the byte total under ?sky=hdr), to download and decode and
// drive the bar to its end; 60 s covers the slowest cold load under four software workers.
const LOAD_COMPLETE_TIMEOUT_MS = 60_000;

// The reveal wait covers the lobby's last leg: the black veil holds until the scene proves its
// first stable frames, then the fade completes; that hold is the slow part under software
// rendering, so it shares the 60 s load budget above.
const REVEAL_TIMEOUT_MS = 60_000;

// The lobby press is the audio gesture, but the track starts only once revealed; 15 s covers the
// fetch, decode and first start of the deferred track after the reveal hands over.
const MUSIC_PLAYING_TIMEOUT_MS = 15_000;

// The cut catalogue surfaces only after the adapter probe and the renderer start, the slow part
// under software rendering, because the boot fails while starting up; 30 s covers that startup
// before the abort becomes the lobby's terminal error state.
const LOBBY_ERROR_TIMEOUT_MS = 30_000;

// The bypass URLs never mount the lobby, so the boot's first canvas scene state is all the page
// promises; 30 s covers a slow boot start under four software workers, as the hold budget above.
const BOOT_SCENE_TIMEOUT_MS = 30_000;

// Other image-source promises continue after a rejected parse; allow their diagnostics to settle.
const TEXTURE_DIAGNOSTICS_TIMEOUT_MS = 30_000;

test('gates the experience until the visitor activates Load Experience', async ({ page }) => {
  // The default sky is generated in memory: the page must never fetch the diagnostic HDR, and the
  // bar reaching 1 below proves the byte total does not wait for it either.
  const hdrRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('.hdr')) hdrRequests.push(request.url());
  });

  // Hold the rotunda so the loading surface stays observable until it is asserted, instead of a
  // fixed one-second delay racing the assertions that follow the click.
  const rotunda = await holdFirstRequest(page, '**/content/rotunda.glb', LOADING_HOLD_TIMEOUT_MS);

  await page.goto(backendPath('/'));
  const lobby = page.locator('#entry-lobby');
  const canvas = page.locator('canvas#scene');

  // 1. Initial idle state: lobby is fully mounted and opaque, no content loading has begun
  await expect(lobby).toHaveCount(1);
  await expect(lobby).toHaveAttribute('data-state', 'idle');
  await expect(lobby).toHaveAttribute('role', 'dialog');
  expect(await canvas.getAttribute('data-scene'), 'scene has not started').toBeNull();

  const loadButton = lobby.locator('#lobby-load-btn');
  await expect(loadButton).toBeEnabled();

  // 2. Click "Load Experience" to start loading
  await loadButton.click();

  // 3. Loading state observed while the rotunda request is held in flight
  await expect(lobby).toHaveAttribute('data-state', 'loading');
  await expect(loadButton).toBeDisabled();
  await expect(lobby.locator('.entry-lobby__loading-pane')).toBeVisible();

  // The loading surface was observed; release the rotunda so the load can finish.
  await rotunda.release();
  await rotunda.waitUntilContinued();

  // 4. Progress bar reaches completion
  const readProgress = async (): Promise<number> =>
    Number((await lobby.locator('progress').getAttribute('value')) ?? '0');
  await expect
    .poll(readProgress, { message: 'the bar reaches the end of the load', timeout: LOAD_COMPLETE_TIMEOUT_MS })
    .toBe(1);

  // 5. Transitions through ready-hidden, black veil, to revealed
  await expect(lobby).toHaveCount(0, { timeout: REVEAL_TIMEOUT_MS });
  await expect(canvas).toHaveAttribute('data-scene', 'ready');

  // Both completed covers are detached once revealed.
  await expect(page.locator('#scene-veil')).toHaveCount(0);

  // Shell elements are interactive
  await expect(page.locator('#shell-header')).not.toHaveAttribute('inert');
  await expect(page.locator('main')).not.toHaveAttribute('inert');

  // Deferred audio starts once revealed
  await expect(page.locator('#shell-header button.music-switch')).toHaveAttribute('data-music', 'playing', {
    timeout: MUSIC_PLAYING_TIMEOUT_MS,
  });

  expect(hdrRequests, 'the default sky requests no .hdr file').toHaveLength(0);
});

// ?sky=hdr: the School Field HDR diagnostic is fetched exactly once and counted in the byte total,
// so the bar still reaches the end.
test('counts and fetches the HDR once under the ?sky=hdr diagnostic', async ({ page }) => {
  const hdrRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('.hdr')) hdrRequests.push(request.url());
  });

  await page.goto(backendPath('/?sky=hdr'));
  const lobby = page.locator('#entry-lobby');
  await lobby.locator('#lobby-load-btn').click();
  await expect
    .poll(async () => Number((await lobby.locator('progress').getAttribute('value')) ?? '0'), {
      message: 'the bar reaches the end of the load, HDR included',
      timeout: LOAD_COMPLETE_TIMEOUT_MS,
    })
    .toBe(1);
  await expect(lobby).toHaveCount(0, { timeout: REVEAL_TIMEOUT_MS });
  expect(hdrRequests).toHaveLength(1);
  expect(new URL(hdrRequests[0]).pathname).toBe('/content/env/school-field-cloudy-1k.hdr');
});

test('reveals the room fallback when the diagnostic HDR request fails', async ({ page }) => {
  const warnings: string[] = [];
  let cutRequests = 0;
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().startsWith('[archviz] sky environment failed;')) {
      warnings.push(message.text());
    }
  });
  await page.route('**/content/env/school-field-cloudy-1k.hdr', (route) => {
    cutRequests += 1;
    return route.abort();
  });
  expectConsoleError(page, /^Failed to load resource: net::ERR_FAILED/,
    'the diagnostic HDR is deliberately cut to exercise the room fallback');
  await page.goto(backendPath('/?e2e=1&gate=on&sky=hdr&music=off'));
  const lobby = page.locator('#entry-lobby');
  await lobby.locator('#lobby-load-btn').click();
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-backend', projectBackend(), { timeout: LOAD_COMPLETE_TIMEOUT_MS });
  await expect(lobby).toHaveCount(0, { timeout: REVEAL_TIMEOUT_MS });
  await expect(canvas).toHaveAttribute('data-scene', 'ready');
  await expect(page.locator('#scene-veil')).toHaveCount(0);
  expect(cutRequests).toBe(1);
  expect(warnings).toHaveLength(1);
  const completed = await page.evaluate(() => ({
    state: window.archvizReveal?.state,
    stableFrames: window.archvizReveal?.frameCountBehindBlack,
    seamReleased: window.archvizTransitionSeam === undefined,
  }));
  expect(completed.state).toBe('revealed');
  expect(completed.stableFrames).toBeGreaterThanOrEqual(2);
  expect(completed.seamReleased).toBe(true);
});

// Keyboard Enter activation on the focused Load button
test('activates Load Experience on Enter from the keyboard', async ({ page }) => {
  // Hold the rotunda so the loading state after the Enter press is observed while held, instead of
  // raced against the content that ends it.
  const rotunda = await holdFirstRequest(page, '**/content/rotunda.glb', LOADING_HOLD_TIMEOUT_MS);

  await page.goto(backendPath('/'));
  const lobby = page.locator('#entry-lobby');
  const loadButton = lobby.locator('#lobby-load-btn');

  await expect(lobby).toHaveAttribute('data-state', 'idle');
  await expect(loadButton).toBeFocused();

  await loadButton.press('Enter');
  await expect(lobby).toHaveAttribute('data-state', 'loading');
  await rotunda.release();
  await rotunda.waitUntilContinued();
  await expect(lobby).toHaveCount(0, { timeout: REVEAL_TIMEOUT_MS });
  await expect(page.locator('canvas#scene')).toHaveAttribute('data-scene', 'ready');
  await expect(lobby).toBeHidden();
});

// A first-frame load cut at the catalogue request must reach the visitor as the lobby's terminal
// error state, not only as a console line. The startup catch in src/main.ts sets the canvas error
// state and hands the failure to the routing in src/ui/startup-failure.ts, which paints the lobby
// error pane while the lobby owns the screen; the two were only tested apart before this case.
test('shows the lobby error state and retry control when the catalogue request is cut', async ({
  page,
}) => {
  // Cutting the request is the same class of failure as a 404 or a broken connection, without
  // needing one: the boot cannot resolve a content set without the catalogue.
  await page.route('**/content/catalog.json', (route) => route.abort());

  // Chromium reports the cut request as a console error whose text carries no URL, so the pattern
  // anchors on the reported text, as the music manifest case does. The startup catch then logs the
  // routed failure once. The progress tracker warns, and warnings are not console errors, so it
  // needs no declaration.
  expectConsoleError(page, /^Failed to load resource: net::ERR_FAILED/,
    'the route abort is a deliberate network failure: the cut catalogue behind the lobby error');
  expectConsoleError(page, /^\[archviz\] the showroom failed to load/,
    'the failed startup is diagnosed in the console while the lobby shows its error state');

  await page.goto(backendPath('/'));
  const lobby = page.locator('#entry-lobby');
  await expect(lobby).toHaveAttribute('data-state', 'idle');
  await lobby.locator('#lobby-load-btn').click();

  // The adapter probe and the renderer start are the slow part under software rendering; the abort
  // fails fast once the catalogue fetch begins.
  await expect(lobby).toHaveAttribute('data-state', 'error', { timeout: LOBBY_ERROR_TIMEOUT_MS });
  const errorPane = lobby.locator('.entry-lobby__error-pane');
  await expect(errorPane).toBeVisible();
  await expect(errorPane.locator('.entry-lobby__error-message')).toHaveText(STARTUP_FAILURE_MESSAGE);
  await expect(lobby.getByRole('button', { name: 'RETRY LOADING' })).toBeVisible();
  // The canvas publishes the same terminal state the lobby pane shows.
  await expect(page.locator('canvas#scene')).toHaveAttribute('data-scene', 'error');
});

test('shows the lobby error state and retry control when the Basis transcoder request is cut', async ({
  page,
}) => {
  // Read the same full content set this desktop load uses. A raw texture-table length would also
  // count the look's deferred swatches, which never load when the initial parse rejects.
  const catalogResponse = await page.request.get('/content/catalog.json');
  expect(catalogResponse.ok()).toBe(true);
  const catalog = parseCatalog(await catalogResponse.json());
  const files = [catalog.rotunda.file, catalog.plinth.file, catalog.looks[0].file];
  const counts = await Promise.all(files.map(async (file) => {
    const response = await page.request.get(contentUrl('/content', file));
    expect(response.ok(), file).toBe(true);
    return countBasisSources(Uint8Array.from(await response.body()).buffer);
  }));
  const textureErrorCount = counts.reduce((total, count) => total + count, 0);
  expect(textureErrorCount).toBeGreaterThan(0);

  await page.route('**/content/basis/basis_transcoder.wasm', (route) => route.abort());
  expectConsoleError(page, /^Failed to load resource: net::ERR_FAILED/,
    'the aborted Basis WASM download deliberately prevents texture transcoding');
  const textureError = /^THREE\.GLTFLoader: Couldn\x27t load texture blob:/;
  for (let index = 0; index < textureErrorCount; index += 1) {
    expectConsoleError(page, textureError,
      'one unique image source in the first-frame GLBs depends on the failed transcoder');
  }
  expectConsoleError(page, /^\[archviz\] the showroom failed to load/,
    'the texture failure propagates to the existing startup catch');

  await page.goto(backendPath('/'));
  const lobby = page.locator('#entry-lobby');
  await expect(lobby).toHaveAttribute('data-state', 'idle');
  await lobby.locator('#lobby-load-btn').click();

  await expect(lobby).toHaveAttribute('data-state', 'error', { timeout: LOBBY_ERROR_TIMEOUT_MS });
  // Rejected parses do not cancel their other image loads. Wait for every derived diagnostic,
  // including a source whose blob fetch settles after the startup catch, before guard teardown.
  await expect.poll(() => browserReports(page).filter((report) =>
    report.kind === 'console' && report.type === 'error' && textureError.test(report.text),
  ).length, { timeout: TEXTURE_DIAGNOSTICS_TIMEOUT_MS }).toBe(textureErrorCount);
  const errorPane = lobby.locator('.entry-lobby__error-pane');
  await expect(errorPane).toBeVisible();
  await expect(errorPane.locator('.entry-lobby__error-message')).toHaveText(STARTUP_FAILURE_MESSAGE);
  await expect(lobby.getByRole('button', { name: 'RETRY LOADING' })).toBeVisible();
  await expect(page.locator('canvas#scene')).toHaveAttribute('data-scene', 'error');
});

// Explicit bypass URLs: gate=off and e2e=1 (without gate=on)
for (const search of ['?gate=off', '?e2e=1']) {
  test(`bypasses the lobby on ${search}`, async ({ page }) => {
    await page.goto(backendPath(`/${search}`));
    await expect(page.locator('canvas#scene')).toHaveAttribute('data-scene', /loading|ready|error/, {
      timeout: BOOT_SCENE_TIMEOUT_MS,
    });
    await expect(page.locator('#entry-lobby')).toHaveCount(0);
  });
}
