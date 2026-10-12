import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

// Product-card and narration cleanup E2E verification.
// Covers four viewports (1440x900, 820x1180, 390x844, 844x390),
// compact card geometry, Material disclosure open/close sync,
// 3-action reflow without Audio, elementFromPoint hit testing,
// touch targets >= 44x44px, synthetic safe insets,
// roving-tabindex keyboard navigation, look refresh, and sheet dismissal.

const SCENE_READY_TIMEOUT = 60_000;
const SWITCH_TIMEOUT = 30_000;

function skipUnlessWebgl2(): void {
  test.skip(test.info().project.name !== 'webgl2', 'the chrome checks are backend independent');
}

async function openScene(page: Page, path = '/?webgl=1&gate=off&e2e=1&proof=1'): Promise<Locator> {
  await page.goto(path);
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  return canvas;
}

interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

async function installSafeArea(page: Page): Promise<SafeArea> {
  const safeArea: SafeArea = { top: 19, right: 23, bottom: 29, left: 17 };
  await page.evaluate((insets) => {
    const root = document.documentElement;
    root.style.setProperty('--safe-area-top', `${insets.top}px`);
    root.style.setProperty('--safe-area-right', `${insets.right}px`);
    root.style.setProperty('--safe-area-bottom', `${insets.bottom}px`);
    root.style.setProperty('--safe-area-left', `${insets.left}px`);
  }, safeArea);
  return safeArea;
}

test.describe('Product-Card Parity and Narration Cleanup', () => {
  test('desktop 1440x900: card hierarchy, actions reflow without Audio, and Material disclosure toggle', async ({
    page,
  }) => {
    skipUnlessWebgl2();
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScene(page);

    const card = page.locator('.product-card');
    await expect(card).toBeVisible();

    // 1. Hierarchy: Thumbnail, Name, Description, Actions, Swatches
    const thumb = card.locator('.product-card__thumb');
    await expect(thumb).toBeVisible();
    const name = card.locator('.product-card__name');
    await expect(name).toHaveText('Wallis Dress');
    const desc = card.locator('.product-card__description');
    await expect(desc).toBeVisible();

    // 2. Three actions reflowed without Audio: Rotate, Reset, Material
    const actions = card.locator('.product-card__action');
    await expect(actions).toHaveCount(3);
    const labels = await actions.allTextContents();
    expect(labels).toEqual(['Rotate', 'Reset', 'Material']);
    expect(labels).not.toContain('Audio');

    // Ensure no audio element or button anywhere inside the card root
    const cardRoot = page.locator('#shell-card');
    await expect(cardRoot.locator('button:has-text("Audio")')).toHaveCount(0);
    await expect(cardRoot.locator('[data-action="audio"]')).toHaveCount(0);

    // 3. Swatches initial disclosure state: open by default
    const swatches = card.locator('.product-card__swatches');
    const materialBtn = card.locator('.product-card__action[data-action="material"]');
    await expect(materialBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(swatches).not.toHaveAttribute('hidden', '');
    await expect(swatches).toBeVisible();

    const swatchBtns = swatches.locator('.product-card__swatch');
    await expect(swatchBtns).toHaveCount(3);
    await expect(swatchBtns.nth(0)).toHaveAttribute('aria-checked', 'true');

    // 4. Material disclosure toggle: click Material closes swatches
    await materialBtn.click();
    await expect(materialBtn).toHaveAttribute('aria-expanded', 'false');
    await expect(swatches).toBeHidden();

    // 5. Click Material again reopens swatches
    await materialBtn.click();
    await expect(materialBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(swatches).toBeVisible();

    // 6. Rotate button functionality
    const rotateBtn = card.locator('.product-card__action[data-action="rotate"]');
    expect(await rotateBtn.getAttribute('aria-pressed')).toBe('false');
    await rotateBtn.click();
    expect(await rotateBtn.getAttribute('aria-pressed')).toBe('true');
    await rotateBtn.click();
    expect(await rotateBtn.getAttribute('aria-pressed')).toBe('false');

    // 7. Swatch selection
    await swatchBtns.nth(1).click();
    await expect(swatchBtns.nth(1)).toHaveAttribute('aria-checked', 'true');
    await expect(swatchBtns.nth(0)).toHaveAttribute('aria-checked', 'false');

    // 8. Reset restores camera and default variant
    const resetBtn = card.locator('.product-card__action[data-action="reset"]');
    await resetBtn.click();
    await expect(swatchBtns.nth(0)).toHaveAttribute('aria-checked', 'true');

    // Zero document scrolling
    const docScroll = await page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return {
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      };
    });
    expect(docScroll.scrollHeight).toBe(900);
    expect(docScroll.scrollWidth).toBe(1440);
    expect(docScroll.scrollX).toBe(0);
    expect(docScroll.scrollY).toBe(0);
  });

  test('desktop keyboard accessibility: Material toggle, roving tabindex swatches, and tab order', async ({
    page,
  }) => {
    skipUnlessWebgl2();
    await page.setViewportSize({ width: 1440, height: 900 });
    const canvas = await openScene(page);

    const rotateBtn = page.locator('.product-card__action[data-action="rotate"]');
    const resetBtn = page.locator('.product-card__action[data-action="reset"]');
    const materialBtn = page.locator('.product-card__action[data-action="material"]');
    const swatches = page.locator('.product-card__swatches');

    const source = page.locator('.product-card__source');
    await source.focus();
    await expect(source).toBeFocused();

    // The source is the tab stop immediately before Rotate.
    await page.keyboard.press('Tab');
    await expect(rotateBtn).toBeFocused();

    // Tab to Reset
    await page.keyboard.press('Tab');
    await expect(resetBtn).toBeFocused();

    // Tab to Material
    await page.keyboard.press('Tab');
    await expect(materialBtn).toBeFocused();

    // Space key activates Material toggle -> closes swatches
    await page.keyboard.press('Space');
    await expect(materialBtn).toHaveAttribute('aria-expanded', 'false');
    await expect(swatches).toBeHidden();

    // Enter key activates Material toggle -> re-opens swatches
    await page.keyboard.press('Enter');
    await expect(materialBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(swatches).toBeVisible();

    // Tab moves into selected swatch
    await page.keyboard.press('Tab');
    const activeSwatch = swatches.locator('.product-card__swatch[aria-checked="true"]');
    await expect(activeSwatch).toBeFocused();

    // ArrowRight moves to next swatch and checks it
    await page.keyboard.press('ArrowRight');
    const lightSwatch = swatches.locator('.product-card__swatch[aria-label="light"]');
    await expect(lightSwatch).toBeFocused();
    await expect(lightSwatch).toHaveAttribute('aria-checked', 'true');
    await expect(canvas).toHaveAttribute('data-variant', 'light', { timeout: SWITCH_TIMEOUT });

    // End moves to last swatch (dark)
    await page.keyboard.press('End');
    const darkSwatch = swatches.locator('.product-card__swatch[aria-label="dark"]');
    await expect(darkSwatch).toBeFocused();
    await expect(darkSwatch).toHaveAttribute('aria-checked', 'true');
    await expect(canvas).toHaveAttribute('data-variant', 'dark', { timeout: SWITCH_TIMEOUT });

    // Home moves to first swatch (base)
    await page.keyboard.press('Home');
    const baseSwatch = swatches.locator('.product-card__swatch[aria-label="base"]');
    await expect(baseSwatch).toBeFocused();
    await expect(baseSwatch).toHaveAttribute('aria-checked', 'true');
    await expect(canvas).toHaveAttribute('data-variant', 'base', { timeout: SWITCH_TIMEOUT });

    // Tab leaves swatches group for Copy link
    await page.keyboard.press('Tab');
    const copyBtn = page.locator('.share__button--copy');
    await expect(copyBtn).toBeFocused();
  });

  test('Reset remains the final intent when pressed immediately after a swatch', async ({ page }) => {
    skipUnlessWebgl2();
    await page.setViewportSize({ width: 1440, height: 900 });
    const canvas = await openScene(page);

    const dark = page.locator('.product-card__swatch[aria-label="dark"]');
    const base = page.locator('.product-card__swatch[aria-label="base"]');
    const reset = page.locator('.product-card__action[data-action="reset"]');

    await dark.click();
    await reset.click();

    await expect(canvas).toHaveAttribute('data-variant', 'base', { timeout: SWITCH_TIMEOUT });
    await expect(base).toHaveAttribute('aria-checked', 'true');
    await expect(dark).toHaveAttribute('aria-checked', 'false');
    await page.waitForTimeout(500);
    await expect(canvas).toHaveAttribute('data-variant', 'base');
  });

  test('look switch: content refresh and Material disclosure consistency', async ({ page }) => {
    skipUnlessWebgl2();
    await page.setViewportSize({ width: 1440, height: 900 });
    const canvas = await openScene(page);

    const card = page.locator('.product-card');
    const materialBtn = card.locator('.product-card__action[data-action="material"]');
    const swatches = card.locator('.product-card__swatches');

    // Close swatches on first look
    await materialBtn.click();
    await expect(materialBtn).toHaveAttribute('aria-expanded', 'false');
    await expect(swatches).toBeHidden();

    // Switch to New Look Dress
    const newLookBtn = page.locator('#looks button[data-look="new-look-dress"]');
    await newLookBtn.click();
    await expect(canvas).toHaveAttribute('data-look', 'new-look-dress', { timeout: SWITCH_TIMEOUT });

    // Heading refreshed
    await expect(card.locator('.product-card__name')).toHaveText('New Look Dress');
    // Swatches disclosure resets to open default
    await expect(materialBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(swatches).toBeVisible();
    // Swatches contain the 3 variants
    await expect(swatches.locator('.product-card__swatch')).toHaveCount(3);
  });

  test('tablet 820x1180: card and rail coexistence without collision', async ({ page }) => {
    skipUnlessWebgl2();
    await page.setViewportSize({ width: 820, height: 1180 });
    await openScene(page);

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
  }) => {
    skipUnlessWebgl2();
    await page.setViewportSize({ width: 390, height: 844 });
    await openScene(page);
    const safeArea = await installSafeArea(page);

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
      left: safeArea.left,
      top: safeArea.top,
      right: 390 - safeArea.right,
      bottom: 844 - safeArea.bottom,
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
  }) => {
    skipUnlessWebgl2();
    await page.setViewportSize({ width: 844, height: 390 });
    await openScene(page);
    const safeArea = await installSafeArea(page);

    const lookPill = page.locator('.shell-pill--look');
    await expect(lookPill).toBeVisible();
    const cardSheet = page.locator('#shell-card');
    await expect(cardSheet).toBeHidden();

    await lookPill.click();
    await expect(cardSheet).toBeVisible();

    const safeRect = {
      left: safeArea.left,
      top: safeArea.top,
      right: 844 - safeArea.right,
      bottom: 390 - safeArea.bottom,
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

  test('breakpoint focus continuity: focus retained across desktop and tablet resize', async ({ page }) => {
    skipUnlessWebgl2();
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScene(page);

    const materialBtn = page.locator('.product-card__action[data-action="material"]');
    await materialBtn.focus();
    await expect(materialBtn).toBeFocused();

    // Resize to tablet
    await page.setViewportSize({ width: 820, height: 1180 });
    await page.waitForTimeout(100);
    await expect(materialBtn).toBeFocused();

    // Resize back to desktop
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(100);
    await expect(materialBtn).toBeFocused();
  });
});
