import { expect, expectConsoleError, test } from './support/fixtures';
import { openShowroom, readCatalog } from './support/showroom';
import { CARD_PATH, SWITCH_TIMEOUT } from './support/product-card';

// A failed card thumbnail shows an empty box, at 1440x900 and 390x844. Why both projects run
// these: support/product-card.ts.

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`failed card thumbnail shows an empty box at ${viewport.width}x${viewport.height}`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const catalog = await readCatalog(request);
    const look = catalog.looks[0];
    expect(look.thumbnail).not.toBeNull();
    const routePattern = `**/content/${look.thumbnail}`;
    await page.route(routePattern, (route) => route.abort());
    expectConsoleError(page, /^Failed to load resource: net::ERR_FAILED/,
      'the opening look thumbnail is deliberately aborted in the strip and card');
    const { canvas } = await openShowroom(page, request, CARD_PATH);
    const pill = page.locator('.shell-pill--look');
    const phone = await pill.isVisible();
    if (phone) await pill.click();
    const empty = page.locator('.product-card__thumb-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toHaveText('');
    await expect(empty).toHaveAttribute('aria-hidden', 'true');
    await expect(page.locator('.product-card__thumb')).toBeHidden();
    await expect(page.locator('.product-card__name')).toHaveText(look.name);

    if (phone) await page.locator('#shell-card .shell-sheet__close').click();
    await page.unroute(routePattern);
    const later = catalog.looks[1];
    await page.locator(`#looks button[data-look="${later.id}"]`).click();
    await expect(canvas).toHaveAttribute('data-look', later.id, { timeout: SWITCH_TIMEOUT });
    if (phone) await pill.click();
    const image = page.locator('.product-card__thumb');
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('alt', later.name);
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    await expect(empty).toBeHidden();
  });
}
