import { expect, expectConsoleError, test } from './support/fixtures';
import type { Page } from '@playwright/test';
import { backendPath } from './support/backend';
import { openShowroom } from './support/showroom';
import { SCENE_READY_TIMEOUT, waitForLoopIdle } from './support/ready';

test('a failed Walk uses exactly one live region for its failure notice', async ({ page, request }) => {
  let fail!: () => void;
  const held = new Promise<void>((resolve) => { fail = resolve; });
  expectConsoleError(page, /Failed to load resource: the server responded with a status of 503/,
    'the collision request is held until Walk is requested, then deliberately returns HTTP 503');
  await page.route('**/collision.glb', async (route) => {
    await held;
    await route.fulfill({ status: 503, body: 'unavailable' });
  });
  try {
    await openShowroom(page, request, '/?e2e=1&attract=0&music=off');
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
  const collisionRequested = new Promise<void>((resolve) => { requested = resolve; });
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
    // This case keeps its own opening: behind the shared opening's longer wait its hover tooltip
    // failed to show in two of three WebGPU runs, and the opening stays until that is explained.
    await page.goto(backendPath('/?e2e=1&attract=0&music=off'));
    await page.waitForFunction(() => window.archvizE2E !== undefined, null, { timeout: SCENE_READY_TIMEOUT });
    await page.evaluate(async () => document.fonts.ready.then(() => undefined));
    await collisionRequested;
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

test('delayed collision keeps Orbit interactive and Orbit cancels pending Walk', async ({ page, request }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let requested!: () => void;
  const collisionRequested = new Promise<void>((resolve) => { requested = resolve; });
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
    await openShowroom(page, request, '/?e2e=1&attract=0');
    await collisionRequested;
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

test('failed collision preserves Orbit input and an explicit retry restores real collision', async ({ page, request }) => {
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
    await openShowroom(page, request, '/?e2e=1&attract=0');
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

test('delayed collision captures the final Orbit pose and hands over only after readiness', async ({ page, request }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/collision.glb', async (route) => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  try {
    await openShowroom(page, request, '/?e2e=1&attract=0');
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
