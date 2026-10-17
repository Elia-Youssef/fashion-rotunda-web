import { expect, test } from './support/fixtures';
import { backendPath } from './support/backend';
import { openShowroom } from './support/showroom';
import { LOOP_STATE_POLL_MS, waitForLoopIdle, waitForSceneInitialization } from './support/ready';

const SCENE_READY_TIMEOUT = 60_000;

// The loop wakes for WAKE_MS, 4 s (src/main.ts), after any input. The wake-window case demands its
// progress after that expiry, so the test polls the loopState wake field until the timer disarms;
// the timeout covers the 4 s window plus slow-machine margin, no shorter than the 6 s fixed wait
// it replaced.
const WAKE_WINDOW_EXPIRY_TIMEOUT_MS = 12_000;

// The sleeping-loop check requires 0.25 m of travel, below the 0.8 m change in radius and
// well above floating point pose noise.
const TOUR_MIN_MOVED_M = 0.25;
// Covers the three second arrival glide plus slow-machine slack.
const TOUR_MOVE_TIMEOUT_MS = 15_000;
// Leave enough idle time to observe the stopped camera before a new tour can start.
const TOUR_IDLE_MS = 6_000;
// The idle delay plus time for a rendered update to publish the running state.
const ATTRACT_START_TIMEOUT_MS = TOUR_IDLE_MS + 5_000;
// Three seconds proves continuing motion; one second proves rest within the next idle wait.
const TOUR_OBSERVE_MS = 3_000;
const TOUR_STOP_OBSERVE_MS = 1_000;
// The arrival contract allows one millimetre of radius and height error.
const TOUR_POSITION_TOLERANCE_M = 0.001;

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
  await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);

  const readFrame = () => page.evaluate(() => ({
    frames: window.archvizE2E!.loopState().frames,
    yaw: window.archvizE2E!.turntableState().yaw,
  }));
  type Frame = Awaited<ReturnType<typeof readFrame>>;
  const progressFrames = 2;
  // mountCamera caps each update at 100 ms, so 20 deg/s is at most 0.035 rad per slow frame.
  // Wall time cannot promise 0.1 rad or even a new frame. Wait for two completed frames (the
  // first loop dt can be zero), then assert actual scene yaw independently of frame delivery.
  // Delivery uses the scene-ready budget because both waits include rendering on a loaded GPU.
  const advancingFrame = async (before: Frame): Promise<Frame> => {
    const delivered = await page.waitForFunction(({ frames, count }) => {
      const state = window.archvizE2E!.loopState();
      return state.frames >= frames + count;
    }, { frames: before.frames, count: progressFrames }, {
      polling: LOOP_STATE_POLL_MS, timeout: SCENE_READY_TIMEOUT,
    });
    await delivered.dispose();
    const after = await readFrame();
    expect(after.yaw, 'the look turns across completed frames').toBeGreaterThan(before.yaw);
    return after;
  };
  const readYaw = async (): Promise<number> => (await readFrame()).yaw;
  const readWakeOpen = async (): Promise<boolean> =>
    page.evaluate(() => window.archvizE2E!.loopState().wakeOpen);

  const before = await readFrame();
  await page.evaluate(() => window.archvizCamera!.turntable.toggle());
  const first = await advancingFrame(before);
  await advancingFrame(first);

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
  // Capture after expiry so both observed frame intervals belong to the turntable's hold.
  const expired = await readFrame();
  const late = await advancingFrame(expired);
  await advancingFrame(late);

  await page.evaluate(() => window.archvizCamera!.turntable.toggle());
  // Owner-confirmed idle proves no frame is due: the held scene yaw below is final and the
  // second read must not differ.
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

test('attract loop circles the look when idle and cancels on input', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(backendPath(`/?e2e=1&attract=1&attractIdle=${TOUR_IDLE_MS}`));
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  await page.waitForFunction(() => window.archvizCamera !== undefined, null, {
    timeout: SCENE_READY_TIMEOUT,
  });
  await expect(canvas).toHaveAttribute('data-attract', '1', { timeout: ATTRACT_START_TIMEOUT_MS });
  await expect.poll(async () => {
    const pos = await page.evaluate(() => window.archvizCamera!.orbit.position);
    return Math.max(Math.abs(Math.hypot(pos[0], pos[2]) - 5), Math.abs(pos[1] - 2));
  }, {
    message: 'the tour converges to a five metre radius at two metres high',
    timeout: TOUR_MOVE_TIMEOUT_MS,
    intervals: [250],
  }).toBeLessThan(TOUR_POSITION_TOLERANCE_M);

  const travel = await page.evaluate(async ({ duration }) => {
    const start = performance.now();
    const initial = window.archvizCamera!.orbit.position;
    let previous = Math.atan2(initial[0], initial[2]);
    let advanced = 0;
    let minimumStep = 0;
    let maximumError = 0;
    do {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const pos = window.archvizCamera!.orbit.position;
      const theta = Math.atan2(pos[0], pos[2]);
      const step = Math.atan2(Math.sin(theta - previous), Math.cos(theta - previous));
      minimumStep = Math.min(minimumStep, step);
      advanced += step;
      previous = theta;
      maximumError = Math.max(maximumError, Math.abs(Math.hypot(pos[0], pos[2]) - 5), Math.abs(pos[1] - 2));
    } while (performance.now() - start < duration);
    return { advanced, minimumStep, maximumError };
  }, { duration: TOUR_OBSERVE_MS });
  expect(travel.advanced, 'azimuth keeps increasing over three seconds').toBeGreaterThan(0.25);
  expect(travel.minimumStep, 'azimuth never reverses').toBeGreaterThanOrEqual(-1e-10);
  expect(travel.maximumError).toBeLessThan(TOUR_POSITION_TOLERANCE_M);

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
  await expect(canvas).toHaveAttribute('data-attract', '0', { timeout: ATTRACT_INPUT_TIMEOUT_MS });
  const drift = await page.evaluate(async ({ duration }) => {
    const start = performance.now();
    const stopped = window.archvizCamera!.orbit.position;
    let maximum = 0;
    do {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const position = window.archvizCamera!.orbit.position;
      maximum = Math.max(maximum, Math.hypot(
        position[0] - stopped[0], position[1] - stopped[1], position[2] - stopped[2],
      ));
    } while (performance.now() - start < duration);
    return maximum;
  }, { duration: TOUR_STOP_OBSERVE_MS });
  expect(drift, 'the camera stays where pointer input stopped the tour').toBeLessThan(1e-10);
});
