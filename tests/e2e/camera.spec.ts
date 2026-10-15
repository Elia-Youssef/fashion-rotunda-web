import { expect, expectConsoleError, test } from './support/fixtures';
import type { Page } from '@playwright/test';
import { backendPath } from './support/backend';
import { waitForLoopIdle } from './support/ready';

const SCENE_READY_TIMEOUT = 60_000;
// The turntable publishes its yaw from rendered frames (mount.ts writeYaw inside update), so every
// progress check polls the published yaw past an earlier reading instead of sampling once.
const YAW_POLL_TIMEOUT_MS = 5_000;
// The loop wakes for WAKE_MS, 4 s (src/main.ts), after any input. The wake-window case demands its
// progress after that expiry, so the test polls the loopState wake field until the timer disarms;
// the timeout covers the 4 s window plus slow-machine margin, no shorter than the 6 s fixed wait
// it replaced.
const WAKE_WINDOW_EXPIRY_TIMEOUT_MS = 12_000;
// The held-pointer handshake: walkthrough.ts moves the foot only in its update, so the proof must
// arrive in a rendered frame while both synthetic pointers are still down.
const TOUCH_MOVE_TIMEOUT_MS = 5_000;
// The held joystick must walk the foot at least this far from the baseline. 0.05 m is 36 ms of the
// 1.4 m/s walk speed, a few rendered frames, so a healthy held drag reaches it well inside the
// poll budget. A straight-up drag also reports an x of about 6e-17 (joystick.ts takes cos(-pi/2)),
// and the walkthrough normalizes only above length 1, so that drift moves the foot under 5e-13 m
// across the whole budget; a strict inequality accepted it, this threshold rejects it.
const MIN_HELD_STEP_M = 0.05;
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
// Half a metre proves forward input works before the rear-wall contact near foot z=6.83.
const WALL_MIN_FORWARD_M = 0.5;
// The observed approach advances 0.14 m per frame. At curved-wall contact, z recedes
// 1.6-4.4 mm per frame while x slides sideways. Allow 1 mm of forward jitter, far below
// an unobstructed step, without rejecting the intended sideways collision response.
const WALL_CONTACT_FORWARD_EPSILON_M = 0.001;
// Three consecutive newer-frame observations reject a single short step as contact.
const WALL_CONTACT_CONFIRMATIONS = 3;
// The 1.33 m approach takes about 1 s at walk speed; allow software-rendered frame delays.
const WALL_MOVE_TIMEOUT_MS = 15_000;
// Only delivery of a latched event observation is polled, never the transient stopped-tour state.
const ATTRACT_INPUT_TIMEOUT_MS = 5_000;

test('a failed Walk uses exactly one live region for its failure notice', async ({ page }) => {
  let fail!: () => void;
  const held = new Promise<void>((resolve) => { fail = resolve; });
  expectConsoleError(page, /Failed to load resource: the server responded with a status of 503/,
    'the collision request is held until Walk is requested, then deliberately returns HTTP 503');
  await page.route('**/collision.glb', async (route) => {
    await held;
    await route.fulfill({ status: 503, body: 'unavailable' });
  });
  try {
    await page.goto(backendPath('/?e2e=1&attract=0&music=off'));
    await page.waitForFunction(() => window.archvizE2E !== undefined, null, { timeout: SCENE_READY_TIMEOUT });
    const announcer = page.locator('.a11y-live-region');
    await expect(announcer).toHaveCount(1);
    const walk = page.locator('button[data-mode="walk"]');
    await walk.click();
    await expect(walk).toHaveText('Loading Walk...');
    fail();
    await expect(walk).toHaveText('Retry Walk');
    const notice = 'Walk could not load. Try again.';
    await expect(announcer).toHaveText(notice);
    const channels = page.locator('[aria-live], [role="status"], [role="alert"]').filter({ hasText: notice });
    await expect(channels, 'exactly one live channel carries the failed Walk message').toHaveCount(1);
    await expect(channels).toHaveText(notice);
    await expect(page.locator('.archviz-walk-hint')).toBeVisible();
    await expect(page.locator('.archviz-walk-hint')).toHaveText(notice);
    await expect(walk).toHaveAttribute('data-tooltip', 'Walk the showroom floor');
  } finally { fail(); }
});

test('Walk states preserve header layout and show one visible failure notice', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let fail!: () => void;
  const held = new Promise<void>((resolve) => { fail = resolve; });
  let requested!: () => void;
  const request = new Promise<void>((resolve) => { requested = resolve; });
  expectConsoleError(page, /Failed to load resource: the server responded with a status of 503/,
    'the held collision request deliberately returns HTTP 503 after the loading reading');
  await page.route('**/collision.glb', async (route) => {
    requested();
    await held;
    await route.fulfill({ status: 503, body: 'unavailable' });
  });
  const walk = page.locator('button[data-mode="walk"]');
  const modeSwitch = page.locator('.archviz-mode-switch');
  const music = page.locator('header button.music-switch');
  const readBoxes = async () => {
    const [switchBox, musicBox] = await Promise.all([modeSwitch.boundingBox(), music.boundingBox()]);
    expect(switchBox, 'the camera switch has a rendered box').not.toBeNull();
    expect(musicBox, 'the Music button has a rendered box').not.toBeNull();
    return { switch: switchBox!, music: musicBox! };
  };
  try {
    // Keep the Music label stable so the camera state is the only header layout input changing.
    await page.goto(backendPath('/?e2e=1&attract=0&music=off'));
    await page.waitForFunction(() => window.archvizE2E !== undefined, null, { timeout: SCENE_READY_TIMEOUT });
    await page.evaluate(async () => document.fonts.ready.then(() => undefined));
    await request;
    await expect(walk).toHaveText('Walk');
    await expect(walk).toHaveAccessibleName('Walk');
    const idle = await readBoxes();

    await walk.click();
    await expect(walk).toHaveText('Loading Walk...');
    await expect(walk).toHaveAccessibleName('Loading Walk...');
    const loading = await readBoxes();

    fail();
    await expect(walk).toHaveText('Retry Walk');
    await expect(walk).toHaveAccessibleName('Retry Walk');
    const failed = await readBoxes();
    // Re-enter after dismissing the old tooltip so the actual failed-state copy is displayed.
    await page.mouse.move(0, 0);
    await page.keyboard.press('Escape');
    await walk.hover();
    const tooltip = page.locator('#a11y-tooltip[role="tooltip"]');
    await expect(tooltip).toBeVisible();
    const visibleFailures = await page.getByText('Walk could not load. Try again.', { exact: true })
      .evaluateAll((elements) => elements.filter((element) => {
        const style = getComputedStyle(element);
        // Live announcements retain a layout box but are fully clipped, so they are not visible copy.
        const clipped = style.clip.replace(/\s/g, '') === 'rect(0px,0px,0px,0px)';
        return !clipped && style.display !== 'none' && style.visibility === 'visible' &&
          Number(style.opacity) !== 0 && element.getClientRects().length > 0;
      }).map((element) => element.className));
    expect(visibleFailures, 'only the visible Walk hint carries the failure text').toEqual(['archviz-walk-hint']);
    await expect(tooltip).toHaveText('Walk the showroom floor');
    expect(idle.switch.width).toBeGreaterThan(0);
    for (const state of [loading, failed]) {
      expect(state.switch.width, 'the camera switch reserves its widest label').toBe(idle.switch.width);
      expect(state.switch.height, 'reserved labels do not add button height').toBe(idle.switch.height);
      expect(state.music, 'the Music button box stays unchanged').toEqual(idle.music);
    }
    expect(await page.evaluate(() => window.archvizCamera!.mode)).toBe('orbit');
  } finally { fail(); }
});

/** A real drag must still own the camera while Walk is unavailable. */
async function expectOrbitInteraction(page: Page): Promise<void> {
  const before = await page.evaluate(() => [...window.archvizCamera!.orbit.position]);
  const box = await page.locator('canvas#scene').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 - 160, box!.y + box!.height / 2, { steps: 8 });
  await page.mouse.up();
  const after = await page.evaluate(() => ({
    mode: window.archvizCamera!.mode, position: [...window.archvizCamera!.orbit.position],
  }));
  expect(after.mode).toBe('orbit');
  expect(Math.hypot(...after.position.map((value, axis) => value - before[axis]))).toBeGreaterThan(1);
}

test('delayed collision keeps Orbit interactive and Orbit cancels pending Walk', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let requested!: () => void;
  const request = new Promise<void>((resolve) => { requested = resolve; });
  let delivered!: () => void;
  const delivery = new Promise<void>((resolve) => { delivered = resolve; });
  await page.route('**/collision.glb', async (route) => {
    const response = await route.fetch();
    requested();
    await held;
    try { await route.fulfill({ response }); }
    finally { delivered(); }
  });
  try {
    await page.goto(backendPath('/?e2e=1&attract=0'));
    await page.waitForFunction(() => window.archvizE2E !== undefined, null, { timeout: SCENE_READY_TIMEOUT });
    await request;
    const before = await page.evaluate(() => [...window.archvizCamera!.orbit.position]);
    await page.locator('button[data-mode="walk"]').click();
    await expect(page.locator('button[data-mode="walk"]')).toHaveAttribute('aria-disabled', 'true');
    expect(await page.evaluate(() => ({ mode: window.archvizCamera!.mode,
      position: [...window.archvizCamera!.orbit.position], walk: window.archvizCamera!.walk !== undefined,
    }))).toEqual({ mode: 'orbit', position: before, walk: false });
    await expectOrbitInteraction(page);
    await page.locator('button[data-mode="orbit"]').click();
    release();
    await delivery;
    await waitForLoopIdle(page);
    expect(await page.evaluate(() => window.archvizCamera!.mode)).toBe('orbit');
    await expect(page.locator('canvas#scene')).toHaveAttribute('data-camera', 'orbit');
    // After canceled delivery, the camera still responds to Orbit input.
    await expectOrbitInteraction(page);
    expect(await page.evaluate(() => window.archvizCamera!.walk)).toBeUndefined();
  } finally { release(); }
});

test('failed collision preserves Orbit input and an explicit retry restores real collision', async ({ page }) => {
  let requests = 0;
  let fail!: () => void;
  const failure = new Promise<void>((resolve) => { fail = resolve; });
  expectConsoleError(page, /Failed to load resource: the server responded with a status of 503/,
    'the first collision request deliberately returns HTTP 503');
  await page.route('**/collision.glb', async (route) => {
    requests += 1;
    if (requests === 1) {
      await failure;
      await route.fulfill({ status: 503, body: 'unavailable' });
    } else await route.continue();
  });
  try {
    await page.goto(backendPath('/?e2e=1&attract=0'));
    await page.waitForFunction(() => window.archvizE2E !== undefined, null, { timeout: SCENE_READY_TIMEOUT });
    const before = await page.evaluate(() => [...window.archvizCamera!.orbit.position]);
    await page.locator('button[data-mode="walk"]').click();
    fail();
    await expect(page.locator('button[data-mode="walk"]')).toHaveText('Retry Walk');
    expect(await page.evaluate(() => ({ mode: window.archvizCamera!.mode,
      walk: window.archvizCamera!.walk !== undefined, position: [...window.archvizCamera!.orbit.position],
    }))).toEqual({ mode: 'orbit', walk: false, position: before });
    await expectOrbitInteraction(page);
    await page.locator('button[data-mode="walk"]').click();
    await expect(page.locator('canvas#scene')).toHaveAttribute('data-camera', 'walk');
    const foot = await page.evaluate(() => {
      const walk = window.archvizCamera!.walk!;
      walk.setPose([0, 0, 5.5], 0, 0);
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' }));
      for (let frame = 0; frame < 100; frame += 1) walk.update(100);
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }));
      return walk.foot;
    });
    expect(requests).toBe(2);
    expect(foot[2], 'retry enables actual movement').toBeLessThan(5.5);
    expect(Math.hypot(foot[0], foot[2]), 'real collision blocks the plinth after retry').toBeGreaterThan(0.9);
    expect(foot[1]).toBeGreaterThanOrEqual(0);
  } finally { fail(); }
});

test('delayed collision captures the final Orbit pose and hands over only after readiness', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/collision.glb', async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  try {
    await page.goto(backendPath('/?e2e=1&attract=0'));
    await page.waitForFunction(() => window.archvizE2E !== undefined, null, { timeout: SCENE_READY_TIMEOUT });
    await page.locator('button[data-mode="walk"]').click();
    await expectOrbitInteraction(page);
    // End the release glide at its current pose before observing the saved return location.
    const live = await page.evaluate(() => {
      const orbit = window.archvizCamera!.orbit;
      orbit.setPose(orbit.position, orbit.target);
      return [...orbit.position];
    });
    release();
    await expect(page.locator('canvas#scene')).toHaveAttribute('data-camera', 'walk');
    expect(await page.evaluate(() => window.archvizCamera!.walk!.enabled)).toBe(true);
    await page.evaluate(async () => window.archvizCamera!.setMode('orbit'));
    const returned = await page.evaluate(() => [...window.archvizCamera!.orbit.position]);
    returned.forEach((value, axis) => expect(value).toBeCloseTo(live[axis], 5));
  } finally { release(); }
});

// Camera and turntable through the real page: a drag orbits the inspection camera, the turntable turns the
// look while it runs, and the loop goes back to sleep once both are still. Reads and the toggle go
// through window.archvizCamera, which ?e2e=1 mounts; the frame-settling wait mirrors idle.spec.ts.
// Both projects run headless by default, so synthetic input controls when the camera and loop wake.

test('a drag across the canvas orbits the camera', async ({ page }) => {
  await page.goto(backendPath('/?e2e=1'));
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  // Scene-ready can publish during the native High benchmark; wait for the camera mount itself.
  await page.waitForFunction(() => window.archvizCamera !== undefined, null, {
    timeout: SCENE_READY_TIMEOUT,
  });

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

test('the turntable turns the look and the loop settles once it stops', async ({ page }) => {
  await page.goto(backendPath('/?e2e=1'));
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  // The first ready frame does not guarantee the turntable handle has mounted yet.
  await page.waitForFunction(() => window.archvizCamera !== undefined, null, {
    timeout: SCENE_READY_TIMEOUT,
  });

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

test('walk mode stops at walls and stays above floor', async ({ page }) => {
  await page.goto(backendPath('/?e2e=1'));
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

  const walkBtn = page.locator('button[data-mode="walk"]');
  await expect(walkBtn).toBeEnabled({ timeout: 10_000 });

  await page.evaluate(async () => {
    await window.archvizCamera?.setMode('walk');
  });
  await expect(canvas).toHaveAttribute('data-camera', 'walk');

  // Point camera toward the nearest wall behind starting pose:
  // Default pose: foot at [0, 0, 5.5], facing origin (yaw = 0).
  // Setting yaw = Math.PI points toward +z. Rear-wall contact is near foot z=6.83,
  // where the collision response blocks forward progress but allows sideways sliding.
  await page.evaluate(() => {
    window.archvizCamera?.walk?.setPose([0, 0, 5.5], Math.PI, 0);
  });

  const readWalkFrame = (): Promise<{ foot: [number, number, number]; frames: number }> =>
    page.evaluate(() => {
      const walk = window.archvizCamera?.walk;
      const scene = document.querySelector<HTMLCanvasElement>('canvas#scene');
      if (walk === undefined || scene?.dataset.frames === undefined) {
        throw new Error('the walkthrough or frame counter is unavailable');
      }
      return { foot: walk.foot, frames: Number(scene.dataset.frames) };
    });
  const before = await readWalkFrame();
  await canvas.focus();
  await page.keyboard.down('KeyW');
  try {
    await expect
      .poll(async () => (await readWalkFrame()).foot[2] - before.foot[2], {
        message: 'forward input moved the foot toward the wall',
        timeout: WALL_MOVE_TIMEOUT_MS,
      })
      .toBeGreaterThanOrEqual(WALL_MIN_FORWARD_M);

    // Keep forward held until consecutive newer-frame readings show no forward progress.
    // Sideways sliding along the curved wall is allowed; repeated reads of one frame do not count.
    let previous = await readWalkFrame();
    let blockedReadings = 0;
    await expect
      .poll(async () => {
        const current = await readWalkFrame();
        if (current.frames <= previous.frames) return false;
        const forwardStep = current.foot[2] - previous.foot[2];
        previous = current;
        blockedReadings = forwardStep <= WALL_CONTACT_FORWARD_EPSILON_M ? blockedReadings + 1 : 0;
        return blockedReadings >= WALL_CONTACT_CONFIRMATIONS;
      }, {
        message: 'the wall stopped forward progress across consecutive newer rendered frames',
        timeout: WALL_MOVE_TIMEOUT_MS,
      })
      .toBe(true);
  } finally {
    await page.keyboard.up('KeyW');
  }

  const { foot } = await readWalkFrame();

  expect(foot[1], 'foot stays on or above the floor').toBeGreaterThanOrEqual(0);
  const distance = Math.hypot(foot[0], foot[2]);
  expect(distance, 'foot stays inside the rotunda walls').toBeLessThan(8.0);
  expect(foot[2], 'foot was stopped by the wall').toBeLessThan(7.5);
});

test('the real collision GLB blocks normal and sprint routes around the plinth and every wall', async ({ page }) => {
  await page.goto(backendPath('/?e2e=1&attract=0'));
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  await expect(page.locator('button[data-mode="walk"]')).toBeEnabled({ timeout: 10_000 });
  await page.evaluate(async () => {
    await window.archvizCamera?.setMode('walk');
  });

  const routes = await page.evaluate(() => {
    const camera = window.archvizCamera;
    const scene = document.querySelector('canvas#scene');
    if (camera === undefined || scene === null) {
      throw new Error('camera or canvas unavailable');
    }
    const run = (foot: [number, number, number], yaw: number, sprint: boolean): [number, number, number] => {
      camera.walk?.setPose(foot, yaw, 0);
      scene.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
      if (sprint) {
        scene.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', bubbles: true }));
      }
      for (let frame = 0; frame < 100; frame += 1) {
        camera.walk?.update(100);
      }
      scene.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
      scene.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', bubbles: true }));
      return camera.walk?.foot ?? [99, 99, 99];
    };

    return {
      plinth: run([0, 0, 5.5], 0, false),
      north: run([0, 0, 4], Math.PI, false),
      south: run([0, 0, -4], 0, true),
      east: run([4, 0, 0], Math.PI / 2, true),
      west: run([-4, 0, 0], -Math.PI / 2, false),
    };
  });

  expect(Math.hypot(routes.plinth[0], routes.plinth[2]), 'plinth blocks a direct approach').toBeGreaterThan(0.9);
  expect(routes.north[2], 'north wall contains normal speed').toBeLessThan(8);
  expect(routes.south[2], 'south wall contains sprint speed').toBeGreaterThan(-9);
  expect(routes.east[0], 'east wall contains sprint speed').toBeLessThan(9.5);
  expect(routes.west[0], 'west wall contains normal speed').toBeGreaterThan(-8);
  for (const foot of Object.values(routes)) {
    expect(foot[1], 'every route stays on the floor').toBeGreaterThanOrEqual(0);
  }
});

/** Horizontal distance between two walk readings' feet, or null when either reading is missing. */
function footDistance(
  after: [number, number, number] | undefined,
  before: [number, number, number] | undefined,
): number | null {
  if (after === undefined || before === undefined) {
    return null;
  }
  return Math.hypot(after[0] - before[0], after[2] - before[2]);
}

/** True when the yaw rose past the baseline: the drag moves right, and rightward pixels raise yaw. */
function yawTurned(after: number | undefined, before: number | undefined): boolean {
  return after !== undefined && before !== undefined && after > before;
}

test.describe('touch walkthrough controls', () => {
  // Boot at the normal test size, then resize to the landscape-phone target below. Chromium's
  // software WebGL loader cannot boot this scene with a touch-emulation GPU profile, but the
  // synthetic PointerEvents below still exercise its `pointerType: 'touch'` production path.

  test('keeps joystick movement and right-side look separate', async ({ page }) => {
    await page.addInitScript(() => {
      const nativeMatchMedia = window.matchMedia.bind(window);
      window.matchMedia = ((query: string) => {
        const result = nativeMatchMedia(query);
        if (query === '(pointer: coarse)') {
          Object.defineProperty(result, 'matches', { configurable: true, value: true });
        }
        return result;
      }) as typeof window.matchMedia;
    });
    await page.goto(backendPath('/?e2e=1&attract=0'));
    const canvas = page.locator('canvas#scene');
    await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
    await page.setViewportSize({ width: 767, height: 430 });
    await expect(page.locator('button[data-mode="walk"]')).toBeEnabled({ timeout: 10_000 });
    await page.evaluate(async () => {
      await window.archvizCamera?.setMode('walk');
    });

    const joystick = page.locator('.archviz-joystick-base');
    await expect(joystick).toBeVisible();
    const joyBox = await joystick.boundingBox();
    const canvasBox = await canvas.boundingBox();
    if (joyBox === null || canvasBox === null) {
      throw new Error('touch controls have no layout box');
    }
    const before = await page.evaluate(() => ({
      foot: window.archvizCamera?.walk?.foot,
      yaw: window.archvizCamera?.walk?.yaw,
    }));

    // Prerequisite: a rendered frame applying the held joystick translation, since walkthrough.ts
    // moves the foot only in update; one atomic read must show a real step past MIN_HELD_STEP_M
    // and the look drag's yaw turn while both pointers are still down.
    const heldGestureApplied = async (): Promise<boolean> => {
      const pose = await page.evaluate(() => ({
        foot: window.archvizCamera?.walk?.foot,
        yaw: window.archvizCamera?.walk?.yaw,
      }));
      const step = footDistance(pose.foot, before.foot);
      return step !== null && step >= MIN_HELD_STEP_M && yawTurned(pose.yaw, before.yaw);
    };

    try {
      await joystick.dispatchEvent('pointerdown', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: joyBox.x + joyBox.width / 2,
        clientY: joyBox.y + joyBox.height / 2,
      });
      await joystick.dispatchEvent('pointermove', {
        pointerId: 1,
        pointerType: 'touch',
        clientX: joyBox.x + joyBox.width / 2,
        clientY: joyBox.y + 8,
      });
      await canvas.dispatchEvent('pointerdown', {
        pointerId: 2,
        pointerType: 'touch',
        clientX: canvasBox.x + canvasBox.width * 0.8,
        clientY: canvasBox.y + canvasBox.height / 2,
      });
      await canvas.dispatchEvent('pointermove', {
        pointerId: 2,
        pointerType: 'touch',
        clientX: canvasBox.x + canvasBox.width * 0.9,
        clientY: canvasBox.y + canvasBox.height / 2,
      });
      await expect
        .poll(heldGestureApplied, {
          timeout: TOUCH_MOVE_TIMEOUT_MS,
          message: 'the held pointers walked the foot and turned the yaw in a rendered frame',
        })
        .toBe(true);
    } finally {
      await joystick.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch' });
      await canvas.dispatchEvent('pointerup', { pointerId: 2, pointerType: 'touch' });
    }
  });
});

test('two round trips orbit-walk-orbit end at starting orbit position within 1 mm', async ({ page }) => {
  await page.goto(backendPath('/?e2e=1'));
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

  const walkBtn = page.locator('button[data-mode="walk"]');
  await expect(walkBtn).toBeEnabled({ timeout: 10_000 });

  const initial = await page.evaluate((): [number, number, number] => {
    const pos = window.archvizCamera?.orbit.position ?? [0, 0, 0];
    return [pos[0], pos[1], pos[2]];
  });

  for (let trip = 0; trip < 2; trip += 1) {
    await page.evaluate(async () => {
      await window.archvizCamera?.setMode('walk');
    });
    await expect(canvas).toHaveAttribute('data-camera', 'walk');

    await page.evaluate(async () => {
      await window.archvizCamera?.setMode('orbit');
    });
    await expect(canvas).toHaveAttribute('data-camera', 'orbit');
  }

  const finalPos = await page.evaluate((): [number, number, number] => {
    const pos = window.archvizCamera?.orbit.position ?? [0, 0, 0];
    return [pos[0], pos[1], pos[2]];
  });

  const diff = Math.hypot(
    finalPos[0] - initial[0],
    finalPos[1] - initial[1],
    finalPos[2] - initial[2],
  );
  expect(diff, 'ends at starting orbit position within 1 mm').toBeLessThan(0.001);
});

test('attract loop tours presets when idle and cancels on input', async ({ page }) => {
  await page.goto(backendPath('/?e2e=1&attract=1&attractIdle=500'));
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

  // The pose at rest, before the tour has started. The camera mounts on the proof view and
  // nothing else moves it, and the tour starts ATTRACT_IDLE_MS (500 ms here) after the camera
  // mounts, one or two frames after the scene reports ready, so this reading precedes the
  // first placement.
  const restPose = await page.evaluate((): [number, number, number] => {
    const pos = window.archvizCamera?.orbit.position ?? [0, 0, 0];
    return [pos[0], pos[1], pos[2]];
  });

  // data-attract becomes 1 within 5 s
  await expect(canvas).toHaveAttribute('data-attract', '1', { timeout: 5_000 });

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
