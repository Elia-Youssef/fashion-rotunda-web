import { expect, test } from './support/fixtures';
import { SCENE_READY_TIMEOUT, waitForSceneInitialization } from './support/ready';
import { CROSSFADE_MS, MAX_FADE_STEP_MS } from '../../src/scene/crossfade';
import { openShowroom } from './support/showroom';
import { holdFirstRequest } from './support/held-request';

// The cross-fade between looks. Both cases read DOM state, canvas dataset flags, scene-graph
// transforms and performance measures that the backend does not change, so every project runs
// them on its own backend: the shared showroom opening pins the page to the backend its project
// promises through the canvas data-backend attribute before any read, and waits on past the
// first frame to the mounted strip and card.

/**
 * The fade begins only after the incoming look has loaded and parsed, and the headless projects
 * render through a slow enough path (and share this machine with other test runs) that the
 * load, not the fade, owns the wait. The chrome suite gives the same click 30 s for the same
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

test('cross-fades to the third look and measures the switch', async ({ page, request }) => {
  const { canvas } = await openShowroom(page, request, '/?e2e=1');
  // The camera and reader handles this case reads mount after the strip and card the opening
  // waits for, so one initialization poll covers both before the first read.
  await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);
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
});

test('two clicks in a row end on the second look and stack nothing on the plinth', async ({
  page,
  request,
}) => {
  test.setTimeout(RAPID_RUN_TIMEOUT);

  const { canvas, catalog } = await openShowroom(page, request, '/?e2e=1');
  await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);
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
});
