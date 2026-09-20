import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { PNG } from 'pngjs';

import { parseCatalog } from '../../src/catalog/catalog';
import type { Catalog } from '../../src/catalog/catalog';

// Goals G5.3 & G5.4 e2e test suite: deep linking, URL synchronization, and 2x screenshot capture.
// Runs on the webgl2 project only (skips webgpu to keep headless testing reproducible and fast).

const READY_TIMEOUT_MS = 60_000;
const SWITCH_TIMEOUT_MS = 30_000;

function skipUnlessWebgl2(): void {
  test.skip(
    test.info().project.name !== 'webgl2',
    'the share checks are backend independent and run headless under webgl2',
  );
}

async function readCatalog(request: APIRequestContext): Promise<Catalog> {
  const response = await request.get('/content/catalog.json');
  expect(response.ok(), 'public/content is served').toBeTruthy();
  const json: unknown = await response.json();
  return parseCatalog(json);
}

function recordConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    errors.push(err.message);
  });
  return errors;
}

test('updates the address bar when changing look and swatch', async ({ page, request }) => {
  skipUnlessWebgl2();
  const errors = recordConsoleErrors(page);
  const catalog = await readCatalog(request);
  const third = catalog.looks[2];

  await page.goto('/?webgl=1&e2e=1');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: READY_TIMEOUT_MS });

  const thumbnails = page.locator('#looks button');
  await expect(thumbnails).toHaveCount(catalog.looks.length, { timeout: READY_TIMEOUT_MS });

  // Every state write is a replaceState, so the entry count cannot move: a back button that walks
  // through look switches and camera moves is the defect this number catches.
  const entriesBefore = await page.evaluate(() => history.length);
  await thumbnails.nth(2).click();

  await expect(canvas).toHaveAttribute('data-look', third.id, { timeout: SWITCH_TIMEOUT_MS });

  await page.getByRole('radio', { name: 'dark' }).click();
  await expect(canvas).toHaveAttribute('data-variant', 'dark', { timeout: SWITCH_TIMEOUT_MS });

  await expect.poll(() => page.url(), { timeout: 5_000 }).toContain(`look=${third.id}`);
  await expect.poll(() => page.url(), { timeout: 5_000 }).toContain('variant=dark');

  const entriesAfter = await page.evaluate(() => history.length);
  expect(entriesAfter, 'the state writes add no history entries').toBe(entriesBefore);

  expect(errors).toEqual([]);
});

test('restores look, variant, camera pose, yaw and turntable from deep link', async ({
  page,
  request,
}) => {
  skipUnlessWebgl2();
  const errors = recordConsoleErrors(page);
  const catalog = await readCatalog(request);
  const third = catalog.looks[2];

  const url = `/?webgl=1&e2e=1&look=${third.id}&variant=dark&cam=1.5,2.0,3.0&yaw=1.000&turn=1`;
  await page.goto(url);

  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: READY_TIMEOUT_MS });

  await expect(canvas).toHaveAttribute('data-look', third.id, { timeout: SWITCH_TIMEOUT_MS });
  await expect(canvas).toHaveAttribute('data-variant', 'dark', { timeout: SWITCH_TIMEOUT_MS });

  // Turntable should be running and yaw advancing
  const readYaw = async (): Promise<number> =>
    Number((await canvas.getAttribute('data-yaw')) ?? '0');
  await expect.poll(readYaw, { timeout: 5_000 }).toBeGreaterThan(1.0);
  const firstYaw = await readYaw();
  await page.waitForTimeout(400);
  const secondYaw = await readYaw();
  expect(secondYaw, 'the turntable yaw is advancing').toBeGreaterThan(firstYaw);

  // Camera orbit position should match the clamped pose within 0.01 metres
  const pos = await page.evaluate((): [number, number, number] | null => {
    return window.archvizCamera?.orbit.position ?? null;
  });
  expect(pos).not.toBeNull();
  if (pos !== null) {
    expect(Math.abs(pos[0] - 1.5)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(pos[1] - 2.0)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(pos[2] - 3.0)).toBeLessThanOrEqual(0.01);
  }

  expect(errors).toEqual([]);
});

test('captures and downloads a still at twice the canvas dimensions', async ({ page }) => {
  skipUnlessWebgl2();
  const errors = recordConsoleErrors(page);

  await page.goto('/?webgl=1&e2e=1');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: READY_TIMEOUT_MS });

  const initialCanvasSize = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('canvas#scene');
    if (c === null) {
      throw new Error('canvas#scene missing');
    }
    return { width: c.width, height: c.height };
  });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Screenshot' }).click();
  const download = await downloadPromise;

  const stream = await download.createReadStream();
  if (stream === null) {
    throw new Error('failed to create download read stream');
  }

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const png = PNG.sync.read(Buffer.concat(chunks));

  // Assert the PNG's size is twice the canvas in both dimensions
  // Allows a tolerance of 1 pixel for fractional subpixel flooring
  expect(
    Math.abs(png.width - initialCanvasSize.width * 2),
    'png width is twice the canvas drawing buffer width',
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(png.height - initialCanvasSize.height * 2),
    'png height is twice the canvas drawing buffer height',
  ).toBeLessThanOrEqual(1);

  // The centre of the frame is the plinth with the look on it. A pure black pixel there is a
  // buffer that was read after the frame was gone, which the file size alone would not show.
  const centre = (Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4;
  const luminanceSum = png.data[centre] + png.data[centre + 1] + png.data[centre + 2];
  expect(luminanceSum, 'the still carries the drawn frame, not an empty buffer').toBeGreaterThan(0);

  // The page draws at the visitor's pixel ratio again, not at twice it, for the rest of the visit.
  const restoredCanvasSize = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('canvas#scene');
    if (c === null) {
      throw new Error('canvas#scene missing');
    }
    return { width: c.width, height: c.height };
  });
  expect(restoredCanvasSize).toEqual(initialCanvasSize);

  expect(errors).toEqual([]);
});
