import type { Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { openShowroom } from './support/showroom';
import { dragTwoFingers } from './support/touch-drag';

async function readPose(page: Page) {
  return page.evaluate(() => {
    const orbit = window.archvizCamera!.orbit;
    return { position: orbit.position, target: orbit.target };
  });
}

test('right-button drag down raises the view within the height limits without rotating', async ({ page, request }) => {
  const { canvas } = await openShowroom(page, request, '/?e2e=1&attract=0');
  const before = await readPose(page);
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('the canvas has no box for a right drag');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(x, y + 60, { steps: 8 });
  await page.mouse.up({ button: 'right' });
  const after = await readPose(page);
  expect(after.target[1]).toBeGreaterThan(before.target[1]);
  expect(after.target[1]).toBeGreaterThanOrEqual(0.15);
  expect(after.target[1]).toBeLessThanOrEqual(2.1);
  for (let axis = 0; axis < 3; axis += 1) {
    expect(after.position[axis] - after.target[axis]).toBeCloseTo(
      before.position[axis] - before.target[axis], 8,
    );
  }
});

test('Page Up raises the target and Home restores its original height', async ({ page, request }) => {
  const { canvas } = await openShowroom(page, request, '/?e2e=1&attract=0');
  const before = await readPose(page);
  await canvas.focus();
  await page.keyboard.press('PageUp');
  expect((await readPose(page)).target[1]).toBeCloseTo(before.target[1] + 0.1, 8);
  await page.keyboard.press('Home');
  const after = await readPose(page);
  expect(after.target).toEqual(before.target);
  for (let axis = 0; axis < 3; axis += 1) expect(after.position[axis]).toBeCloseTo(before.position[axis], 8);
});

test('a two-finger drag down raises the target through native input events', async ({ page, request }) => {
  const { canvas } = await openShowroom(page, request, '/?e2e=1&attract=0');
  const before = await readPose(page);
  await dragTwoFingers(page, canvas, 60);
  const after = await readPose(page);
  expect(after.target[1]).toBeGreaterThan(before.target[1]);
  expect(after.target[1]).toBeGreaterThanOrEqual(0.15);
  expect(after.target[1]).toBeLessThanOrEqual(2.1);
  for (let axis = 0; axis < 3; axis += 1) {
    expect(after.position[axis] - after.target[axis]).toBeCloseTo(
      before.position[axis] - before.target[axis], 6,
    );
  }
});

test('a link with a fourth camera number restores the target height', async ({ page, request }) => {
  await openShowroom(page, request, '/?e2e=1&attract=0&cam=0,2.3,4.2,1.6');
  const pose = await readPose(page);
  expect(pose.target).toEqual([0, 1.6, 0]);
  expect(pose.position[1]).toBeCloseTo(2.3, 8);
});
