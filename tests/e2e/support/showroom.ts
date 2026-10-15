import { expect } from './fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { backendPath, projectBackend } from './backend';
import { parseCatalog } from '../../../src/catalog/catalog';
import type { Catalog } from '../../../src/catalog/catalog';

// One opening shared by the specs that read the visitor chrome. canvas[data-scene] turns ready on
// the first drawn frame with content (src/main.ts publishes it from the frame handler), but the
// camera, the mode switch, the look strip and the product card mount only after the tier benchmark
// settles and the post chain is prepared, in one later block in src/main.ts, and the page
// publishes no single "UI mounted" state. A spec that reads before that block sees an empty
// navigation, an empty product card and no mode buttons, so the opening waits for the elements
// themselves instead of any earlier signal.

/**
 * The budget for the whole opening, catalogue fetch through the late chrome mount. The benchmark
 * behind settleTier() and the post-chain preparation can outlast the five-second assertion
 * default on a loaded runner, so every opening step shares the scene-initialization budget.
 */
export const SHOWROOM_OPEN_TIMEOUT = 60_000;

/** The catalogue the page itself will load, read through the same server and parsed strictly. */
export async function readCatalog(request: APIRequestContext): Promise<Catalog> {
  const response = await request.get('/content/catalog.json');
  expect(response.ok(), 'public/content is on disk and served').toBeTruthy();
  const json: unknown = await response.json();
  return parseCatalog(json);
}

/** What a caller needs after the opening: the scene canvas and the parsed catalogue. */
export interface Showroom {
  canvas: Locator;
  catalog: Catalog;
}

/**
 * Opens the page on the project's own backend and waits past the first frame to the mounted
 * visitor chrome: one strip button per catalogue look, exactly one of them marked current, the
 * product card mounted, and both camera mode buttons in the header.
 */
export async function openShowroom(
  page: Page,
  request: APIRequestContext,
  path: string,
): Promise<Showroom> {
  const catalog = await readCatalog(request);
  await page.goto(backendPath(path));
  const canvas = page.locator('canvas#scene');
  // A silent fallback would run these DOM checks against the wrong renderer, so the page must
  // publish the backend its project promises before any check reads the DOM.
  await expect(canvas).toHaveAttribute('data-backend', projectBackend(), {
    timeout: SHOWROOM_OPEN_TIMEOUT,
  });
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SHOWROOM_OPEN_TIMEOUT });
  // The strip holds one button per catalogue look, exactly one of them the catalogue's current
  // mark, and the card and both camera mode buttons are mounted.
  await expect(page.locator('#looks button')).toHaveCount(catalog.looks.length, {
    timeout: SHOWROOM_OPEN_TIMEOUT,
  });
  await expect(page.locator('#looks button[aria-current="true"]')).toHaveCount(1, {
    timeout: SHOWROOM_OPEN_TIMEOUT,
  });
  await expect(page.locator('.product-card')).toHaveCount(1, { timeout: SHOWROOM_OPEN_TIMEOUT });
  await expect(page.locator('button[data-mode="orbit"]')).toHaveCount(1, {
    timeout: SHOWROOM_OPEN_TIMEOUT,
  });
  await expect(page.locator('button[data-mode="walk"]')).toHaveCount(1, {
    timeout: SHOWROOM_OPEN_TIMEOUT,
  });
  return { canvas, catalog };
}
