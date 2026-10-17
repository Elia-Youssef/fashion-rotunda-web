import { expect, test } from './support/fixtures';
import { openShowroom } from './support/showroom';
import { CARD_PATH } from './support/product-card';
import { SAFE_AREA, installSafeArea } from './support/lightdrawer-helpers';

// Product-card geometry across 820x1180, 390x844 and 844x390: card and rail coexistence,
// elementFromPoint hit testing, touch targets >= 44x44px, synthetic safe insets, sheet dismissal
// and focus continuity across a resize. Why both projects run these: support/product-card.ts.

test.describe('Product-Card Parity and Narration Cleanup', () => {
  test('tablet 820x1180: card and rail coexistence without collision', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 820, height: 1180 });
    await openShowroom(page, request, CARD_PATH);

    const rail = page.locator('#looks');
    const card = page.locator('#shell-card');
    await expect(rail).toBeVisible();
    await expect(card).toBeVisible();

    const railBox = await rail.boundingBox();
    const cardBox = await card.boundingBox();
    expect(railBox).not.toBeNull();
    expect(cardBox).not.toBeNull();

    if (railBox && cardBox) {
      // Horizontal rail sits under header on left, card sits upper right
      const intersects =
        railBox.x < cardBox.x + cardBox.width &&
        cardBox.x < railBox.x + railBox.width &&
        railBox.y < cardBox.y + cardBox.height &&
        cardBox.y < railBox.y + railBox.height;
      expect(intersects, 'rail and card do not intersect on tablet').toBe(false);
    }

    // Zero document scrolling
    const docScroll = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }));
    expect(docScroll.scrollHeight).toBe(1180);
  });

  test('phone portrait 390x844: Look sheet internal scroll, touch sizes, safe insets, and hit testing', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openShowroom(page, request, CARD_PATH);
    await installSafeArea(page);

    // Look sheet starts closed behind Look pill
    const lookPill = page.locator('.shell-pill--look');
    await expect(lookPill).toBeVisible();
    const cardSheet = page.locator('#shell-card');
    await expect(cardSheet).toBeHidden();

    // Click Look pill opens Look sheet
    await lookPill.click();
    await expect(cardSheet).toBeVisible();

    // Safe rectangle: x: 17, y: 19, right: 367, bottom: 815
    const safeRect = {
      left: SAFE_AREA.left,
      top: SAFE_AREA.top,
      right: 390 - SAFE_AREA.right,
      bottom: 844 - SAFE_AREA.bottom,
    };

    // Target elements to verify
    const targets = [
      { name: 'Rotate', selector: '#shell-card .product-card__action[data-action="rotate"]' },
      { name: 'Reset', selector: '#shell-card .product-card__action[data-action="reset"]' },
      { name: 'Material', selector: '#shell-card .product-card__action[data-action="material"]' },
      { name: 'swatch-1', selector: '#shell-card .product-card__swatch.product-card__swatch--base' },
      { name: 'swatch-2', selector: '#shell-card .product-card__swatch.product-card__swatch--light' },
      { name: 'swatch-3', selector: '#shell-card .product-card__swatch.product-card__swatch--dark' },
      { name: 'close', selector: '#shell-card .shell-sheet__close' },
    ];

    for (const target of targets) {
      const locator = page.locator(target.selector);
      await expect(locator).toBeVisible();
      await locator.scrollIntoViewIfNeeded();

      const box = await locator.boundingBox();
      expect(box, `${target.name} has a bounding box`).not.toBeNull();
      if (!box) continue;

      // Touch sizing: at least 44x44 CSS px
      expect(box.width, `${target.name} width >= 44px`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${target.name} height >= 44px`).toBeGreaterThanOrEqual(44);

      // Actionable point
      const actionX = box.x + box.width / 2;
      const actionY = box.y + box.height / 2;

      // Safe rectangle check
      expect(actionX, `${target.name} actionX >= safeLeft`).toBeGreaterThanOrEqual(safeRect.left);
      expect(actionX, `${target.name} actionX <= safeRight`).toBeLessThanOrEqual(safeRect.right);
      expect(actionY, `${target.name} actionY >= safeTop`).toBeGreaterThanOrEqual(safeRect.top);
      expect(actionY, `${target.name} actionY <= safeBottom`).toBeLessThanOrEqual(safeRect.bottom);

      // elementFromPoint hit testing
      const hitMatch = await page.evaluate(
        ({ x, y, sel }) => {
          const el = document.querySelector(sel);
          const hitEl = document.elementFromPoint(x, y);
          return hitEl === el || el?.contains(hitEl) || false;
        },
        { x: actionX, y: actionY, sel: target.selector },
      );
      expect(hitMatch, `${target.name} actionable point matches elementFromPoint`).toBe(true);
    }

    // Zero document scrolling
    const docScroll = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }));
    expect(docScroll.scrollHeight).toBe(844);

    // Escape closes Look sheet and returns focus to Look pill
    await page.keyboard.press('Escape');
    await expect(cardSheet).toBeHidden();
    await expect(lookPill).toBeFocused();
  });

  test('short landscape 844x390: Look sheet internal scroll, touch sizes, safe insets, and hit testing', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });
    await openShowroom(page, request, CARD_PATH);
    await installSafeArea(page);

    const lookPill = page.locator('.shell-pill--look');
    await expect(lookPill).toBeVisible();
    const cardSheet = page.locator('#shell-card');
    await expect(cardSheet).toBeHidden();

    await lookPill.click();
    await expect(cardSheet).toBeVisible();

    const safeRect = {
      left: SAFE_AREA.left,
      top: SAFE_AREA.top,
      right: 844 - SAFE_AREA.right,
      bottom: 390 - SAFE_AREA.bottom,
    };

    const targets = [
      { name: 'Rotate', selector: '#shell-card .product-card__action[data-action="rotate"]' },
      { name: 'Reset', selector: '#shell-card .product-card__action[data-action="reset"]' },
      { name: 'Material', selector: '#shell-card .product-card__action[data-action="material"]' },
      { name: 'swatch-1', selector: '#shell-card .product-card__swatch.product-card__swatch--base' },
      { name: 'swatch-2', selector: '#shell-card .product-card__swatch.product-card__swatch--light' },
      { name: 'swatch-3', selector: '#shell-card .product-card__swatch.product-card__swatch--dark' },
      { name: 'close', selector: '#shell-card .shell-sheet__close' },
    ];

    for (const target of targets) {
      const locator = page.locator(target.selector);
      await expect(locator).toBeVisible();
      await locator.scrollIntoViewIfNeeded();

      const box = await locator.boundingBox();
      expect(box, `${target.name} has a bounding box`).not.toBeNull();
      if (!box) continue;

      expect(box.width, `${target.name} width >= 44px`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${target.name} height >= 44px`).toBeGreaterThanOrEqual(44);

      const actionX = box.x + box.width / 2;
      const actionY = box.y + box.height / 2;

      expect(actionX, `${target.name} actionX inside safe width`).toBeGreaterThanOrEqual(safeRect.left);
      expect(actionX, `${target.name} actionX inside safe width`).toBeLessThanOrEqual(safeRect.right);
      expect(actionY, `${target.name} actionY inside safe height`).toBeGreaterThanOrEqual(safeRect.top);
      expect(actionY, `${target.name} actionY inside safe height`).toBeLessThanOrEqual(safeRect.bottom);

      const hitMatch = await page.evaluate(
        ({ x, y, sel }) => {
          const el = document.querySelector(sel);
          const hitEl = document.elementFromPoint(x, y);
          return hitEl === el || el?.contains(hitEl) || false;
        },
        { x: actionX, y: actionY, sel: target.selector },
      );
      expect(hitMatch, `${target.name} actionable point matches elementFromPoint`).toBe(true);
    }

    const docScroll = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }));
    expect(docScroll.scrollHeight).toBe(390);

    await page.keyboard.press('Escape');
    await expect(cardSheet).toBeHidden();
    await expect(lookPill).toBeFocused();
  });

  test('breakpoint focus continuity: focus retained across desktop and tablet resize', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openShowroom(page, request, CARD_PATH);

    const materialBtn = page.locator('.product-card__action[data-action="material"]');
    await materialBtn.focus();
    await expect(materialBtn).toBeFocused();

    // Resize to tablet
    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(materialBtn).toBeFocused();

    // Resize back to desktop
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(materialBtn).toBeFocused();
  });
});
