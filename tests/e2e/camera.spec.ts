import { expect, test } from '@playwright/test';

// G4.1 + G4.4 through the real page: a drag orbits the inspection camera, the turntable turns the
// look while it runs, and the loop goes back to sleep once both are still. Reads and the toggle go
// through window.archvizCamera, which ?e2e=1 mounts; the frame-settling wait mirrors idle.spec.ts.
// Headless only, like idle.spec.ts: a pointer moving over a headed window is an input nobody
// asked for.

test('a drag across the canvas orbits the camera', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgl2', 'runs headless with synthetic input, like idle.spec.ts');
  await page.goto('/?webgl=1&e2e=1');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: 30_000 });

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
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: 30_000 });

  const readYaw = async (): Promise<number> => Number((await canvas.getAttribute('data-yaw')) ?? '0');

  await page.evaluate(() => {
    window.archvizCamera?.turntable.toggle();
  });
  await expect.poll(readYaw, { timeout: 5_000 }).toBeGreaterThan(0.1);
  const first = await readYaw();
  await page.waitForTimeout(400);
  const second = await readYaw();
  expect(second, 'the yaw keeps advancing while the turntable runs').toBeGreaterThan(first);

  // One hover, no button, which the orbit ignores and main.ts's wake() answers by arming its
  // four-second window. Without an input the window is never armed after the load and the wait
  // below would prove nothing; with it, the window closes while the turntable is running and
  // writes the loop's animating flag, which is the state this assertion is here to watch.
  const box = await canvas.boundingBox();
  if (box === null) {
    throw new Error('the canvas has no box to hover over');
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(6_000);
  const late = await readYaw();
  expect(late, 'the yaw advanced past the wake window').toBeGreaterThan(second);
  await page.waitForTimeout(400);
  expect(await readYaw(), 'and is still advancing after it').toBeGreaterThan(late);

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
