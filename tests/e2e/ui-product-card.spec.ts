import { expect, test } from './support/fixtures';
import { openShowroom } from './support/showroom';
import { CARD_PATH, SWITCH_TIMEOUT } from './support/product-card';

// Product-card behaviour at 1440x900: compact card geometry, the 3-action reflow without Audio,
// Material disclosure open/close sync, roving-tabindex keyboard navigation, the Reset race and the
// look refresh. Why both projects run these: support/product-card.ts.

test.describe('Product-Card Parity and Narration Cleanup', () => {
  test('desktop 1440x900: card hierarchy, actions reflow without Audio, and Material disclosure toggle', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openShowroom(page, request, CARD_PATH);

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
    request,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { canvas } = await openShowroom(page, request, CARD_PATH);

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
    const lightSwatch = swatches.locator('.product-card__swatch[aria-label="Light"]');
    await expect(lightSwatch).toBeFocused();
    await expect(lightSwatch).toHaveAttribute('aria-checked', 'true');
    await expect(canvas).toHaveAttribute('data-variant', 'light', { timeout: SWITCH_TIMEOUT });

    // End moves to last swatch (dark)
    await page.keyboard.press('End');
    const darkSwatch = swatches.locator('.product-card__swatch[aria-label="Dark charcoal"]');
    await expect(darkSwatch).toBeFocused();
    await expect(darkSwatch).toHaveAttribute('aria-checked', 'true');
    await expect(canvas).toHaveAttribute('data-variant', 'dark', { timeout: SWITCH_TIMEOUT });

    // Home moves to first swatch (base)
    await page.keyboard.press('Home');
    const baseSwatch = swatches.locator('.product-card__swatch[aria-label="Default"]');
    await expect(baseSwatch).toBeFocused();
    await expect(baseSwatch).toHaveAttribute('aria-checked', 'true');
    await expect(canvas).toHaveAttribute('data-variant', 'base', { timeout: SWITCH_TIMEOUT });

    // Tab leaves swatches group for Copy link
    await page.keyboard.press('Tab');
    const copyBtn = page.locator('.share__button--copy');
    await expect(copyBtn).toBeFocused();
  });

  test('Reset remains the final intent when pressed immediately after a swatch', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { canvas } = await openShowroom(page, request, CARD_PATH);

    const dark = page.locator('.product-card__swatch[aria-label="Dark charcoal"]');
    const base = page.locator('.product-card__swatch[aria-label="Default"]');
    const reset = page.locator('.product-card__action[data-action="reset"]');

    await dark.click();
    await reset.click();

    await expect(canvas).toHaveAttribute('data-variant', 'base', { timeout: SWITCH_TIMEOUT });
    await expect(base).toHaveAttribute('aria-checked', 'true');
    await expect(dark).toHaveAttribute('aria-checked', 'false');
    await expect(canvas).toHaveAttribute('data-variant', 'base');
  });

  test('look switch: content refresh and Material disclosure consistency', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const { canvas } = await openShowroom(page, request, CARD_PATH);

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
});
