import { expect, test } from '@playwright/test';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { parseCatalog } from '../../src/catalog/catalog';
import type { Catalog } from '../../src/catalog/catalog';

// G5.1, G5.2: the visitor-facing chrome. The strip switches the look, the card names it, the
// swatches swap the mannequin and Reset returns the default. webgl2 project only, like the scene
// suite: the checks are about the DOM, not the backend, and the webgpu project opens a window on
// this machine that the look loads would hold open for minutes.

const SCENE_READY_TIMEOUT = 60_000;
/** One look fetch through the local preview server, well past the five-second assertion default. */
const SWITCH_TIMEOUT = 30_000;

function skipUnlessWebgl2(): void {
  test.skip(test.info().project.name !== 'webgl2', 'the chrome checks are backend independent');
}

/** The catalogue the page itself will load, read through the same server. */
async function readCatalog(request: APIRequestContext): Promise<Catalog> {
  const response = await request.get('/content/catalog.json');
  expect(response.ok(), 'public/content is on disk and served').toBeTruthy();
  const json: unknown = await response.json();
  return parseCatalog(json);
}

/** Opens the page and waits for the frame that has the look on the plinth. */
async function openScene(page: Page, path: string): Promise<Locator> {
  await page.goto(path);
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  return canvas;
}

test('the strip switches the look and the card names it', async ({ page, request }) => {
  skipUnlessWebgl2();
  const catalog = await readCatalog(request);
  const third = catalog.looks[2];

  const canvas = await openScene(page, '/?webgl=1');

  const thumbnails = page.locator('#looks button');
  await expect(thumbnails).toHaveCount(catalog.looks.length, { timeout: SCENE_READY_TIMEOUT });
  await thumbnails.nth(2).click();

  await expect(canvas).toHaveAttribute('data-look', third.id, { timeout: SWITCH_TIMEOUT });
  await expect(page.locator('.product-card h2')).toHaveText(third.name);
  await expect(thumbnails.nth(2)).toHaveAttribute('aria-current', 'true');
});

test('the swatches switch the mannequin and Reset returns the default', async ({
  page,
  request,
}) => {
  skipUnlessWebgl2();
  const catalog = await readCatalog(request);
  const first = catalog.looks[0];
  expect(first.variants, 'the first look carries a dark variant').toContain('dark');

  const canvas = await openScene(page, '/?webgl=1');

  await page.getByRole('radio', { name: 'dark' }).click();
  await expect(canvas).toHaveAttribute('data-variant', 'dark', { timeout: SWITCH_TIMEOUT });
  await expect(page.getByRole('radio', { name: 'dark' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(canvas).toHaveAttribute('data-variant', first.defaultVariant, {
    timeout: SWITCH_TIMEOUT,
  });
  await expect(page.getByRole('radio', { name: first.defaultVariant })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});
