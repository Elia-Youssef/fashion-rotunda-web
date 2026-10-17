import { expect, test } from './support/fixtures';
import type { Page } from '@playwright/test';
import { openShowroom } from './support/showroom';
import { installSafeArea, type SafeArea } from './support/safe-area';

async function assertInsideSafeRectangle(
  page: Page,
  selector: string,
  safeArea: SafeArea,
  label: string,
): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport, `${label}: viewport is available`).not.toBeNull();
  if (viewport === null) {
    return;
  }
  const box = await page.locator(selector).boundingBox();
  expect(box, `${label}: ${selector} has a bounding box`).not.toBeNull();
  if (box === null) {
    return;
  }
  expect(box.x, `${label}: ${selector} clears the left inset`).toBeGreaterThanOrEqual(safeArea.left);
  expect(box.y, `${label}: ${selector} clears the top inset`).toBeGreaterThanOrEqual(safeArea.top);
  expect(
    box.x + box.width,
    `${label}: ${selector} clears the right inset`,
  ).toBeLessThanOrEqual(viewport.width - safeArea.right);
  expect(
    box.y + box.height,
    `${label}: ${selector} clears the bottom inset`,
  ).toBeLessThanOrEqual(viewport.height - safeArea.bottom);
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  test(`synthetic safe areas contain overlay chrome at ${viewport.width}x${viewport.height}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    await openShowroom(page, request, '/?e2e=1&proof=1');
    const safeArea = await installSafeArea(page);
    const tag = `${viewport.width}x${viewport.height} synthetic safe area`;

    // Closed state: header actions, rail, both launcher pills, and the persistent footer must all
    // stay in the rectangle. This checks physical bounds, not resolved zero-inset CSS strings.
    for (const selector of [
      'header button.music-switch',
      'button[data-mode="orbit"]',
      'button[data-mode="walk"]',
      '#looks',
      '.shell-pill--look',
      '#shell-light-toggle',
      '.proof-panel__measure',
      '.badge',
    ]) {
      await assertInsideSafeRectangle(page, selector, safeArea, `${tag} closed`);
    }

    await page.locator('.shell-pill--look').click();
    await expect(page.locator('#shell-card')).toBeVisible();
    for (const selector of [
      '#shell-card',
      '#shell-card .shell-sheet__close',
      '.proof-panel__measure',
      '.badge',
    ]) {
      await assertInsideSafeRectangle(page, selector, safeArea, `${tag} Look sheet`);
    }

    await page.locator('#shell-card .shell-sheet__close').click();
    await page.locator('#shell-light-toggle').click();
    await expect(page.locator('#shell-light-panel')).toBeVisible();
    for (const selector of [
      '#shell-light-row',
      '#shell-light-row .shell-sheet__close',
      '.proof-panel__measure',
      '.badge',
    ]) {
      await assertInsideSafeRectangle(page, selector, safeArea, `${tag} Light sheet`);
    }
  });
}
