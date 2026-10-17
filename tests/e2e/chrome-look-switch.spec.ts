import { expect, expectConsoleError, test } from './support/fixtures';
import { openShowroom, readCatalog } from './support/showroom';

// The visitor-facing chrome. The strip switches the look, the card names it, the
// swatches swap the mannequin and Reset returns the default. The checks are about the DOM, not the
// backend, so both projects run them; each page is pinned to its project's backend through the
// canvas data-backend attribute before any DOM reading.

/** One look fetch through the local preview server, well past the five-second assertion default. */
const SWITCH_TIMEOUT = 30_000;

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`failed look switch keeps the previous look and reports once at ${viewport.width}x${viewport.height}`, async ({
    page, request,
  }) => {
    await page.setViewportSize(viewport);
    const { canvas, catalog } = await openShowroom(page, request, '/?e2e=1&music=off');
    const previous = catalog.looks[0];
    const target = catalog.looks[1];
    const routePattern = `**/content/${target.file}`;
    await page.route(routePattern, (route) => route.abort());
    expectConsoleError(page, /^Failed to load resource: net::ERR_FAILED/,
      'the later look GLB is deliberately aborted to exercise switch recovery');
    const live = page.locator('.a11y-live-region');
    await expect(live).toHaveCount(1);
    await expect(live).toHaveAttribute('aria-live', 'polite');
    const liveRegionCount = await page.locator('[aria-live]').count();
    const targetButton = page.locator(`#looks button[data-look="${target.id}"]`);
    await targetButton.click();

    const message = 'That look could not load. Select it again to try once more.';
    const notice = page.locator('[data-look-status]');
    await expect(notice).toHaveCount(1);
    await expect(notice).toHaveText(message);
    await expect(notice).toBeVisible();
    await expect(live).toHaveText(message);
    await expect(page.locator('[aria-live]')).toHaveCount(liveRegionCount);
    await expect(canvas).toHaveAttribute('data-look', previous.id);
    await expect(page.locator('.product-card h2')).toHaveText(previous.name);
    await expect(page.locator(`#looks button[data-look="${previous.id}"]`)).toHaveAttribute('aria-current', 'true');
    await expect(targetButton).not.toHaveAttribute('aria-busy');
    await expect(targetButton).not.toHaveAttribute('aria-current');

    await page.unroute(routePattern);
    await targetButton.click();
    await expect(canvas).toHaveAttribute('data-look', target.id, { timeout: SWITCH_TIMEOUT });
    await expect(notice).toBeHidden();
    await expect(notice).toHaveText('');
    await expect(targetButton).toHaveAttribute('aria-current', 'true');
  });
}

test('the strip switches the look and the card names it', async ({ page, request }) => {
  const { canvas, catalog } = await openShowroom(page, request, '/?gate=off');
  const third = catalog.looks[2];

  const thumbnails = page.locator('#looks button');
  await thumbnails.nth(2).click();

  await expect(canvas).toHaveAttribute('data-look', third.id, { timeout: SWITCH_TIMEOUT });
  await expect(page.locator('.product-card h2')).toHaveText(third.name);
  await expect(thumbnails.nth(2)).toHaveAttribute('aria-current', 'true');
});

test('the swatches switch the mannequin and Reset returns the default', async ({
  page,
  request,
}) => {
  const catalog = await readCatalog(request);
  const first = catalog.looks[0];
  expect(first.variants, 'the first look carries a dark variant').toContain('dark');

  const { canvas } = await openShowroom(page, request, '/?gate=off');

  await page.getByRole('radio', { name: 'Dark charcoal' }).click();
  await expect(canvas).toHaveAttribute('data-variant', 'dark', { timeout: SWITCH_TIMEOUT });
  await expect(page.getByRole('radio', { name: 'Dark charcoal' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(canvas).toHaveAttribute('data-variant', first.defaultVariant, {
    timeout: SWITCH_TIMEOUT,
  });
  await expect(page.getByRole('radio', { name: 'Default' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});
