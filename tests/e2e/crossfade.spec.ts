import { expect, test } from '@playwright/test';
import { waitForSceneInitialization } from './support/ready';
import type { ConsoleMessage, Locator, Page } from '@playwright/test';
import { CROSSFADE_MS, MAX_FADE_STEP_MS } from '../../src/scene/crossfade';
import { parseCatalog } from '../../src/catalog/catalog';
import { holdFirstRequest } from './support/held-request';

// The cross-fade between looks. The shared fade and resource-lifecycle checks run once on the
// webgl2 project, using its forced fallback fixture.

const SCENE_READY_TIMEOUT = 60_000;
/**
 * The fade begins only after the incoming look has loaded and parsed, and the headless webgl2
 * project renders through a slow enough path (and shares this machine with other test runs) that
 * the load, not the fade, owns the wait. The chrome suite gives the same click 30 s for the same
 * reason; against a real GPU and a warm cache the whole switch measures 90-500 ms.
 */
const FADE_TIMEOUT = 30_000;
// A stalled draw contributes at most MAX_FADE_STEP_MS: allow the minimum clamped advances plus
// one scheduling margin, each with the existing 5 s frame-handshake allowance. Faster draws need
// more advances but consume less wall time; this is a bounded stall budget, not a duration promise.
const FADE_FRAME_TIMEOUT = 5_000;
const FADE_END_TIMEOUT = (Math.ceil(CROSSFADE_MS / MAX_FADE_STEP_MS) + 1) * FADE_FRAME_TIMEOUT;
/** A switch whose first faded frame never arrives would sit at the load ceiling, not near it. */
const SWITCH_MEASURE_LIMIT_MS = 15_000;
/** Three look loads of the unoptimized set, 6 to 17 MB each, well past the 60 s default. */
const RAPID_RUN_TIMEOUT = 180_000;
const TURNTABLE_YAW = Math.PI / 3;

function skipUnlessWebgl2(): void {
  test.skip(
    test.info().project.name !== 'webgl2',
    'the shared fade and resource-lifecycle checks run once on webgl2',
  );
}

function expectTurntableYaw(
  state: {
    yaw: number;
    plinthWorldYaw: number | null;
    activeLookWorldYaw: number | null;
    outgoingLookWorldYaw: number | null;
    plinthAttached: boolean;
    activeLookAttached: boolean;
    outgoingLookAttached: boolean;
  },
  outgoing: boolean,
): void {
  expect(state.yaw).toBeCloseTo(TURNTABLE_YAW, 5);
  expect(state.plinthAttached).toBe(true);
  expect(state.activeLookAttached).toBe(true);
  expect(state.plinthWorldYaw).toBeCloseTo(TURNTABLE_YAW, 5);
  expect(state.activeLookWorldYaw).toBeCloseTo(TURNTABLE_YAW, 5);
  if (outgoing) {
    expect(state.outgoingLookAttached).toBe(true);
    expect(state.outgoingLookWorldYaw).toBeCloseTo(TURNTABLE_YAW, 5);
  } else {
    expect(state.outgoingLookWorldYaw).toBeNull();
  }
}

/** Opens the page and waits for the frame that has the first look on the plinth. */
async function openScene(page: Page, path: string): Promise<Locator> {
  await page.goto(path);
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);
  return canvas;
}

test('cross-fades to the third look and measures the switch', async ({ page }) => {
  skipUnlessWebgl2();
  const errors: ConsoleMessage[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message);
    }
  });

  const canvas = await openScene(page, '/?webgl=1&e2e=1');
  // The strip mounts after the tier benchmark, which runs for up to two seconds after ready.
  const thumbnails = page.locator('nav#looks button');
  await expect(thumbnails.nth(2)).toBeVisible({ timeout: SCENE_READY_TIMEOUT });
  const thirdId = await thumbnails.nth(2).getAttribute('data-look');
  expect(thirdId, 'the third thumbnail carries its look id').not.toBeNull();

  const turntableSet = await page.evaluate((yaw) => {
    const camera = window.archvizCamera;
    if (camera === undefined) {
      return false;
    }
    camera.turntable.setYaw(yaw);
    return true;
  }, TURNTABLE_YAW);
  expect(turntableSet, 'the test camera handle is mounted').toBe(true);
  const beforeSwitch = await page.evaluate(() => window.archvizE2E?.turntableState());
  expect(beforeSwitch).toBeDefined();
  expectTurntableYaw(beforeSwitch!, false);

  await thumbnails.nth(2).click();

  // Wait for the fade flag and both participants' transforms in one synchronous observation.
  await expect(async () => {
    const duringFade = await page.evaluate(() => ({
      fading: document.querySelector<HTMLCanvasElement>('canvas#scene')?.dataset.fade,
      state: window.archvizE2E?.turntableState(),
    }));
    expect(duringFade.fading).toBe('1');
    expect(duringFade.state).toBeDefined();
    expectTurntableYaw(duringFade.state!, true);
  }).toPass({ timeout: FADE_TIMEOUT });
  // Wait for accumulated scheduled-frame progress to finish the fade.
  await expect(canvas).toHaveAttribute('data-fade', '0', { timeout: FADE_END_TIMEOUT });

  const switches = await page.evaluate(() =>
    performance.getEntriesByName('look-switch').map((entry) => entry.duration),
  );
  expect(switches.length, 'at least one look-switch measure exists').toBeGreaterThan(0);
  expect(switches[switches.length - 1], 'the latest look-switch duration').toBeLessThan(
    SWITCH_MEASURE_LIMIT_MS,
  );

  await expect(canvas).toHaveAttribute('data-look', String(thirdId));
  expect(
    errors.map((message) => message.text()),
    'no console errors during the switch',
  ).toEqual([]);
});

test('two clicks in a row end on the second look and stack nothing on the plinth', async ({
  page,
  request,
}) => {
  skipUnlessWebgl2();
  test.setTimeout(RAPID_RUN_TIMEOUT);
  const errors: ConsoleMessage[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message);
    }
  });

  const canvas = await openScene(page, '/?webgl=1&e2e=1');
  const thumbnails = page.locator('nav#looks button');
  await expect(thumbnails.nth(2)).toBeVisible({ timeout: SCENE_READY_TIMEOUT });

  const startId = await canvas.getAttribute('data-look');
  expect(startId, 'the start look is published').not.toBeNull();
  const startThumbnail = page.locator(`nav#looks button[data-look="${String(startId)}"]`);
  await expect(startThumbnail).toBeVisible();
  // data-memory is renderer.info.memory as geometries/textures, the same live GPU counts
  // tests/e2e/scene.spec.ts compares across ten switches. It is read here with exactly one look
  // on the plinth, and read again below with exactly one look on the plinth: the interrupted
  // pair must leave the page holding one look's resources, not two.
  const memoryBefore = await canvas.getAttribute('data-memory');
  expect(memoryBefore, 'the memory reading is published').not.toBeNull();

  const secondId = await thumbnails.nth(2).getAttribute('data-look');
  expect(secondId, 'the third thumbnail carries its look id').not.toBeNull();

  const response = await request.get('/content/catalog.json');
  expect(response.ok(), 'the catalogue is served').toBe(true);
  const json: unknown = await response.json();
  const catalog = parseCatalog(json);
  const firstId = await thumbnails.nth(1).getAttribute('data-look');
  const firstLook = catalog.looks.find((look) => look.id === firstId);
  expect(firstLook, 'the first request has a catalogue file').toBeDefined();
  const hold = await holdFirstRequest(page, `**/content/${firstLook!.file}`, FADE_TIMEOUT);
  try {
    await thumbnails.nth(1).click();
    await hold.waitUntilEntered();
    // Wait for the held request's busy state before superseding it.
    await expect(thumbnails.nth(1)).toHaveAttribute('aria-busy', 'true', { timeout: FADE_TIMEOUT });
    await thumbnails.nth(2).click();
  } finally {
    hold.release();
  }
  await hold.waitUntilContinued();

  // The second click wins whichever request finishes first, and only its look reaches the plinth.
  await expect(canvas).toHaveAttribute('data-look', String(secondId), { timeout: FADE_TIMEOUT });
  await expect(canvas).toHaveAttribute('data-fade', '0', { timeout: FADE_TIMEOUT });

  // Back to the look the page started on, so the two readings describe the same plinth. Anything
  // the interrupted switch failed to free would show as a higher count here.
  await startThumbnail.click();
  await expect(canvas).toHaveAttribute('data-look', String(startId), { timeout: FADE_TIMEOUT });
  await expect(canvas).toHaveAttribute('data-fade', '0', { timeout: FADE_TIMEOUT });
  await expect(canvas).toHaveAttribute('data-memory', String(memoryBefore), {
    timeout: FADE_TIMEOUT,
  });

  expect(
    errors.map((message) => message.text()),
    'no console errors during the rapid pair',
  ).toEqual([]);
});
