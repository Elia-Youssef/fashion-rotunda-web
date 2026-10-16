import { expect, test } from './support/fixtures';
import { openShowroom } from './support/showroom';

// A test that drives walk input first proves the Walk control is active, not merely mounted:
// openShowroom proves existence only, and the button sits aria-disabled while a walk load is
// pending (src/camera/mode-switch.ts). A healthy boot passes at once, so the 10 s is headroom
// for the late chrome mount on a loaded machine, not time the run normally spends.
const WALK_READY_TIMEOUT_MS = 10_000;

// The held-pointer handshake: walkthrough.ts moves the foot only in its update, so the proof must
// arrive in a rendered frame while both synthetic pointers are still down.
const TOUCH_MOVE_TIMEOUT_MS = 5_000;

// The held joystick must walk the foot at least this far from the baseline. 0.05 m is 36 ms of the
// 1.4 m/s walk speed, a few rendered frames, so a healthy held drag reaches it well inside the
// poll budget. A straight-up drag also reports an x of about 6e-17 (joystick.ts takes cos(-pi/2)),
// and the walkthrough normalizes only above length 1, so that drift moves the foot under 5e-13 m
// across the whole budget; a strict inequality accepted it, this threshold rejects it.
const MIN_HELD_STEP_M = 0.05;

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

test('walk mode stops at walls and stays above floor', async ({ page, request }) => {
  const { canvas } = await openShowroom(page, request, '/?e2e=1');

  const walkBtn = page.locator('button[data-mode="walk"]');
  await expect(walkBtn).toBeEnabled({ timeout: WALK_READY_TIMEOUT_MS });

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

test('the real collision GLB blocks normal and sprint routes around the plinth and every wall', async ({ page, request }) => {
  await openShowroom(page, request, '/?e2e=1&attract=0');
  await expect(page.locator('button[data-mode="walk"]')).toBeEnabled({ timeout: WALK_READY_TIMEOUT_MS });
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

  test('keeps joystick movement and right-side look separate', async ({ page, request }) => {
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
    const { canvas } = await openShowroom(page, request, '/?e2e=1&attract=0');
    await page.setViewportSize({ width: 767, height: 430 });
    await expect(page.locator('button[data-mode="walk"]')).toBeEnabled({ timeout: WALK_READY_TIMEOUT_MS });
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

test('two round trips orbit-walk-orbit end at starting orbit position within 1 mm', async ({ page, request }) => {
  const { canvas } = await openShowroom(page, request, '/?e2e=1');

  const walkBtn = page.locator('button[data-mode="walk"]');
  await expect(walkBtn).toBeEnabled({ timeout: WALK_READY_TIMEOUT_MS });

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
