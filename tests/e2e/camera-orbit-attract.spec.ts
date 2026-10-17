import { expect, test } from './support/fixtures';
import { backendPath } from './support/backend';
import { openShowroom } from './support/showroom';
import { waitForLoopIdle, waitForSceneInitialization } from './support/ready';

const SCENE_READY_TIMEOUT = 60_000;

// The turntable publishes its yaw from rendered frames (mount.ts writeYaw inside update), so every
// progress check polls the published yaw past an earlier reading instead of sampling once.
const YAW_POLL_TIMEOUT_MS = 5_000;

// The loop wakes for WAKE_MS, 4 s (src/main.ts), after any input. The wake-window case demands its
// progress after that expiry, so the test polls the loopState wake field until the timer disarms;
// the timeout covers the 4 s window plus slow-machine margin, no shorter than the 6 s fixed wait
// it replaced.
const WAKE_WINDOW_EXPIRY_TIMEOUT_MS = 12_000;

/**
 * The camera travel the attract test demands before it accepts the tour as running. The tour's
 * first leg glides the proof view [0, 1.7, 4.2] to the entrance view [0, 2.2, 6.2], the
 * catalogue's second preset: 2.06 m of straight camera travel over ATTRACT_MOVE_MS (3 s),
 * eased in and out. 0.25 m is 12 percent of that leg, which the ease reaches about 940 ms into
 * the move, so the figure proves real placement work early in the leg while standing far above
 * the orbit's spherical round-trip noise, on the order of 1e-15 m.
 */
const TOUR_MIN_MOVED_M = 0.25;

/** Covers the 500 ms idle start, the eased 940 ms to the minimum travel, and slow-machine slack. */
const TOUR_MOVE_TIMEOUT_MS = 15_000;

// The short cancellation case uses 500 ms to keep its input checks quick; the separate sleeping-loop
// case waits 6 s, past the 4 s input wake window. The idle tour arms after the configured delay and
// publishes data-attract from a rendered frame's update (src/camera/mount.ts), so the wait covers
// the idle delay plus that first publishing frame; 5 s leaves the rest to slow machines.
const ATTRACT_START_TIMEOUT_MS = 5_000;

// Only delivery of a latched event observation is polled, never the transient stopped-tour state.
const ATTRACT_INPUT_TIMEOUT_MS = 5_000;

// Longer than main.ts's 4 s wake window; input after startup anchors the full idle wait.
const SLEEPING_TOUR_IDLE_MS = 6_000;
// Covers the full idle wait plus the eased travel and the same slow-machine margin as the short case.
const SLEEPING_TOUR_TIMEOUT_MS = SLEEPING_TOUR_IDLE_MS + TOUR_MOVE_TIMEOUT_MS;

// Camera and turntable through the real page: a drag orbits the inspection camera, the turntable turns the
// look while it runs, and the loop goes back to sleep once both are still. Reads and the toggle go
// through window.archvizCamera, which ?e2e=1 mounts; the openings share openShowroom, which pins the
// project's backend and waits past the late chrome mount the camera belongs to.
// Both projects run headless by default, so synthetic input controls when the camera and loop wake.

test('a drag across the canvas orbits the camera', async ({ page, request }) => {
  const { canvas } = await openShowroom(page, request, '/?e2e=1');

  const before = await page.evaluate((): number[] => window.archvizCamera?.orbit.position ?? []);
  expect(before.length).toBe(3);

  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('the canvas has no box to drag across');
  }
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX - 160, centerY + 40, { steps: 8 });
  await page.mouse.up();

  const after = await page.evaluate((): number[] => window.archvizCamera?.orbit.position ?? []);
  expect(after.length).toBe(3);
  const moved = Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]);
  // 160 px of yaw and 40 px of polar at 0.005 rad per pixel is 0.8 rad around a 4.26 m radius,
  // which is 3.2 m of travel. A tenth of a metre would have passed on a drag applied at a
  // twentieth of its scale, so the threshold is set where the real gesture lands.
  expect(moved, 'the drag moved the camera').toBeGreaterThan(2.0);
});

test('the turntable turns the look and the loop settles once it stops', async ({ page, request }) => {
  const { canvas } = await openShowroom(page, request, '/?e2e=1');

  const readYaw = async (): Promise<number> => Number((await canvas.getAttribute('data-yaw')) ?? '0');
  // The e2e handle mounts after archvizCamera, so an early read reports the window as open rather
  // than passing before the field exists.
  const readWakeOpen = async (): Promise<boolean> =>
    page.evaluate(() => window.archvizE2E?.loopState().wakeOpen ?? true);

  await page.evaluate(() => {
    window.archvizCamera?.turntable.toggle();
  });
  await expect.poll(readYaw, { timeout: YAW_POLL_TIMEOUT_MS }).toBeGreaterThan(0.1);
  const first = await readYaw();
  // Prerequisite: a rendered frame publishing a yaw past `first`, since the yaw advances only in update.
  await expect
    .poll(readYaw, {
      timeout: YAW_POLL_TIMEOUT_MS,
      message: 'the yaw keeps advancing while the turntable runs',
    })
    .toBeGreaterThan(first);
  const second = await readYaw();

  // One hover, no button, which the orbit ignores and main.ts's wake() answers by arming its
  // four-second window. Without an input the window is never armed after the load and the poll
  // below would prove nothing; with it, the window closes while the turntable is running and
  // writes the loop's animating flag, which is the state this assertion is here to watch.
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('the canvas has no box to hover over');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Prerequisite: the four-second wake window has expired. The wake field reads the same timer
  // wake() arms, and that timer disarms at expiry even though the turntable keeps the loop going.
  // The open read pins the field to the real window: a field stuck on closed would pass the poll
  // and let the yaw checks below run inside the window.
  expect(await readWakeOpen(), 'the hover armed the wake window').toBe(true);
  await expect
    .poll(readWakeOpen, {
      timeout: WAKE_WINDOW_EXPIRY_TIMEOUT_MS,
      message: 'the wake window never closed',
    })
    .toBe(false);
  // Prerequisite: a rendered frame after expiry publishing a yaw past the pre-window `second`.
  await expect
    .poll(readYaw, {
      timeout: YAW_POLL_TIMEOUT_MS,
      message: 'the yaw advanced past the wake window',
    })
    .toBeGreaterThan(second);
  const late = await readYaw();
  // Prerequisite: a rendered frame publishing a yaw past `late`.
  await expect
    .poll(readYaw, {
      timeout: YAW_POLL_TIMEOUT_MS,
      message: 'and is still advancing after it',
    })
    .toBeGreaterThan(late);

  await page.evaluate(() => {
    window.archvizCamera?.turntable.toggle();
  });
  // The turntable publishes its yaw from rendered frames (see the file-top comment), so owner
  // confirmed idle proves no frame is due: the held reading below is final and the second read
  // must not differ.
  await waitForLoopIdle(page);
  const stopped = await readYaw();
  expect(await readYaw(), 'the look holds where the turntable stopped').toBe(stopped);
});

test('the idle tour wakes the sleeping loop after the input wake window', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const { canvas } = await openShowroom(
    page, request, `/?e2e=1&attract=1&attractIdle=${SLEEPING_TOUR_IDLE_MS}`,
  );
  await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);
  // Window input resets the tour's clock and opens main.ts's wake window without moving the orbit.
  const start = await page.evaluate(() => {
    window.dispatchEvent(new Event('pointermove'));
    return { at: performance.now(), position: window.archvizCamera!.orbit.position };
  });
  expect(await page.evaluate(() => window.archvizE2E!.loopState().wakeOpen)).toBe(true);
  await expect.poll(
    () => page.evaluate(() => window.archvizE2E!.loopState().wakeOpen),
    { timeout: WAKE_WINDOW_EXPIRY_TIMEOUT_MS },
  ).toBe(false);
  await waitForLoopIdle(page);
  await expect(canvas).toHaveAttribute('data-attract', '1', { timeout: SLEEPING_TOUR_TIMEOUT_MS });
  const startedAt = await page.evaluate(() => performance.now());
  expect(startedAt - start.at, 'the tour waited the full idle delay after input')
    .toBeGreaterThanOrEqual(SLEEPING_TOUR_IDLE_MS);
  await expect.poll(async () => {
    const position = await page.evaluate(() => window.archvizCamera!.orbit.position);
    return Math.hypot(
      position[0] - start.position[0], position[1] - start.position[1], position[2] - start.position[2],
    );
  }, {
    message: 'the tour woke the loop and moved the camera after the wake window',
    timeout: TOUR_MOVE_TIMEOUT_MS,
    intervals: [250],
  }).toBeGreaterThanOrEqual(TOUR_MIN_MOVED_M);
});

test('attract loop tours presets when idle and cancels on input', async ({ page }) => {
  await page.goto(backendPath('/?e2e=1&attract=1&attractIdle=500'));
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  // Scene-ready can publish during the native High benchmark; wait for the camera mount itself.
  await page.waitForFunction(() => window.archvizCamera !== undefined, null, {
    timeout: SCENE_READY_TIMEOUT,
  });

  // The pose at rest, before the tour has started. The camera mounts on the proof view and
  // nothing else moves it, and the tour starts ATTRACT_IDLE_MS (500 ms here) after the camera
  // mounts, so the read at the mount itself precedes the first placement. A read at scene-ready
  // can land during the benchmark instead, before the camera exists: the [0, 0, 0] fallback then
  // sits about 4.5 m from the proof view, and the movement poll below would pass at once without
  // the tour ever moving the camera. This opening stays hand-rolled for the same reason:
  // openShowroom's chrome waits could push the read past the idle window it must precede.
  const restPose = await page.evaluate((): [number, number, number] => {
    const pos = window.archvizCamera?.orbit.position ?? [0, 0, 0];
    return [pos[0], pos[1], pos[2]];
  });

  await expect(canvas).toHaveAttribute('data-attract', '1', { timeout: ATTRACT_START_TIMEOUT_MS });

  // The tour must actually move the camera, not only publish its state: a tour that never
  // placed a pose still turned data-attract on. Poll the published orbit pose until it has
  // travelled TOUR_MIN_MOVED_M from the rest pose (see the constant for the figure's origin).
  await expect
    .poll(async () => {
      const pos = await page.evaluate((): [number, number, number] => {
        const position = window.archvizCamera?.orbit.position ?? [0, 0, 0];
        return [position[0], position[1], position[2]];
      });
      return Math.hypot(pos[0] - restPose[0], pos[1] - restPose[1], pos[2] - restPose[2]);
    }, {
      message: 'the attract tour never moved the camera',
      timeout: TOUR_MOVE_TIMEOUT_MS,
      intervals: [250],
    })
    .toBeGreaterThanOrEqual(TOUR_MIN_MOVED_M);

  // This listener is registered after mount.ts's bubbling window input listener. Latch the
  // real state in the trusted event task, before any later frame can restart the idle tour.
  let runningAfterInput: boolean | undefined;
  await page.exposeFunction('recordAttractInput', (running: boolean | undefined) => {
    runningAfterInput = running;
  });
  await page.evaluate(() => {
    const observedWindow = window as typeof window & {
      recordAttractInput: (running: boolean | undefined) => Promise<void>;
    };
    const onInput = (event: PointerEvent): void => {
      if (!event.isTrusted) return;
      window.removeEventListener('pointermove', onInput);
      void observedWindow.recordAttractInput(window.archvizCamera?.attract.running);
    };
    window.addEventListener('pointermove', onInput);
  });

  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('the canvas has no box to move pointer over');
  }
  expect(await page.evaluate(() => window.archvizCamera?.attract.running), 'the tour is running before input')
    .toBe(true);
  await page.mouse.move(box.x + 50, box.y + 50);
  await expect
    .poll(() => runningAfterInput, {
      message: 'trusted pointer input synchronously cancelled the running tour',
      timeout: ATTRACT_INPUT_TIMEOUT_MS,
    })
    .toBe(false);
});
