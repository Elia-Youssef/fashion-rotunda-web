import { expect, test } from '@playwright/test';

const SCENE_READY_TIMEOUT = 60_000;
// The turntable publishes its yaw from rendered frames (mount.ts writeYaw inside update), so every
// progress check polls the published yaw past an earlier reading instead of sampling once.
const YAW_POLL_TIMEOUT_MS = 5_000;
// The loop wakes for WAKE_MS, 4 s (src/main.ts), after any input. Waiting past that expiry is the
// temporal contract of the wake-window case: the progress it demands is rendered after the window.
const WAKE_WINDOW_EXPIRY_WAIT_MS = 6_000;
// The held-pointer handshake: walkthrough.ts moves the foot only in its update, so the proof must
// arrive in a rendered frame while both synthetic pointers are still down.
const TOUCH_MOVE_TIMEOUT_MS = 5_000;
// The held joystick must walk the foot at least this far from the baseline. 0.05 m is 36 ms of the
// 1.4 m/s walk speed, a few rendered frames, so a healthy held drag reaches it well inside the
// poll budget. A straight-up drag also reports an x of about 6e-17 (joystick.ts takes cos(-pi/2)),
// and the walkthrough normalizes only above length 1, so that drift moves the foot under 5e-13 m
// across the whole budget; a strict inequality accepted it, this threshold rejects it.
const MIN_HELD_STEP_M = 0.05;

// Camera and turntable through the real page: a drag orbits the inspection camera, the turntable turns the
// look while it runs, and the loop goes back to sleep once both are still. Reads and the toggle go
// through window.archvizCamera, which ?e2e=1 mounts; the frame-settling wait mirrors idle.spec.ts.
// Headless only, like idle.spec.ts: a pointer moving over a headed window is an input nobody
// asked for.

test('a drag across the canvas orbits the camera', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgl2', 'runs headless with synthetic input, like idle.spec.ts');
  await page.goto('/?webgl=1&e2e=1');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

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
  test.skip(test.info().project.name !== 'webgl2', 'runs headless with synthetic input, like idle.spec.ts');
  await page.goto('/?webgl=1&e2e=1');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

  const readYaw = async (): Promise<number> => Number((await canvas.getAttribute('data-yaw')) ?? '0');

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
  // four-second window. Without an input the window is never armed after the load and the wait
  // below would prove nothing; with it, the window closes while the turntable is running and
  // writes the loop's animating flag, which is the state this assertion is here to watch.
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('the canvas has no box to hover over');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Prerequisite: the four-second wake window has expired; this long wait is kept as that contract.
  await page.waitForTimeout(WAKE_WINDOW_EXPIRY_WAIT_MS);
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
  const stopped = await readYaw();
  await page.waitForTimeout(500);
  expect(await readYaw(), 'the look holds where the turntable stopped').toBe(stopped);

  const readFrames = async (): Promise<number> =>
    Number((await canvas.getAttribute('data-frames')) ?? '0');
  let previous = await readFrames();
  let settled = false;
  for (let attempt = 0; attempt < 12 && !settled; attempt += 1) {
    await page.waitForTimeout(1000);
    const current = await readFrames();
    settled = current > 0 && current === previous;
    previous = current;
  }
  expect(settled, 'the frame counter stopped within twelve seconds').toBe(true);
});

test('walk mode stops at walls and stays above floor', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgl2', 'runs headless with synthetic input, like idle.spec.ts');
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  await page.goto('/?webgl=1&e2e=1');
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
  // The wall behind is at z ~ 7.5 m. Setting yaw = Math.PI points toward [0, 0, 7.5].
  await page.evaluate(() => {
    window.archvizCamera?.walk?.setPose([0, 0, 5.5], Math.PI, 0);
  });

  await canvas.focus();
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(3000);
  await page.keyboard.up('KeyW');

  const foot = await page.evaluate((): [number, number, number] => {
    return window.archvizCamera?.walk?.foot ?? [0, -1, 0];
  });

  expect(foot[1], 'foot stays on or above the floor').toBeGreaterThanOrEqual(0);
  const distance = Math.hypot(foot[0], foot[2]);
  expect(distance, 'foot stays inside the rotunda walls').toBeLessThan(8.0);
  expect(foot[2], 'foot was stopped by the wall').toBeLessThan(7.5);
  expect(errors).toEqual([]);
});

test('the real collision GLB blocks normal and sprint routes around the plinth and every wall', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgl2', 'runs headless with synthetic input, like idle.spec.ts');
  await page.goto('/?webgl=1&e2e=1&attract=0');
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
    test.skip(test.info().project.name !== 'webgl2', 'runs headless with synthetic input, like idle.spec.ts');
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
    await page.goto('/?webgl=1&e2e=1&attract=0');
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
  test.skip(test.info().project.name !== 'webgl2', 'runs headless with synthetic input, like idle.spec.ts');
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  await page.goto('/?webgl=1&e2e=1');
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
  expect(errors).toEqual([]);
});

test('attract loop tours presets when idle and cancels on input', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgl2', 'runs headless with synthetic input, like idle.spec.ts');
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  await page.goto('/?webgl=1&e2e=1&attract=1&attractIdle=500');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

  // data-attract becomes 1 within 5 s
  await expect(canvas).toHaveAttribute('data-attract', '1', { timeout: 5_000 });

  // Synthetic pointermove sets data-attract to 0
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('the canvas has no box to move pointer over');
  }
  await page.mouse.move(box.x + 50, box.y + 50);
  await expect(canvas).toHaveAttribute('data-attract', '0', { timeout: 2_000 });

  expect(errors).toEqual([]);
});
