import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

// G6.2, G6.3: onboarding, tooltips and accessibility pass.
// Tests the first-visit onboarding card, Skip dismissal, the DOM tab walk order,
// roving tabindex arrow navigation on swatches, the tooltip on focus, live region announcements
// on look changes, and ensures no console errors occur.
// WebGL2 project only (backend-independent DOM checks, following idle.spec.ts pattern).

const SCENE_READY_TIMEOUT = 60_000;
const SWITCH_TIMEOUT = 30_000;

// The longest run in the documented order is the thumbnail strip, seven looks plus the controls
// around it. Twelve presses cover it; an unbounded loop would hang instead of failing.
const MAX_TAB_PRESSES = 12;

function skipUnlessWebgl2(): void {
  test.skip(test.info().project.name !== 'webgl2', 'the a11y checks are backend independent');
}

async function focusMatches(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => document.activeElement?.matches(sel) === true, selector);
}

/** Presses Tab at most MAX_TAB_PRESSES times, stopping as soon as the selector holds focus. */
async function tabUntil(page: Page, selector: string): Promise<void> {
  for (let i = 0; i < MAX_TAB_PRESSES; i += 1) {
    if (await focusMatches(page, selector)) {
      return;
    }
    await page.keyboard.press('Tab');
  }
}

test('onboarding sequence, focus order, swatch navigation and live announcements', async ({ page }) => {
  skipUnlessWebgl2();
  // Six steps on a software-rendered page: the suite's default minute ran out under load.
  test.setTimeout(120_000);

  const consoleErrors: ConsoleMessage[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg);
    }
  });

  await page.goto('/?webgl=1&e2e=1&onboarding=1');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

  // 1. Onboarding card appears with the first step
  const card = page.locator('.onboarding-card');
  await expect(card).toBeVisible();
  const cardTitle = card.locator('.onboarding-card__title');
  await expect(cardTitle).toHaveText('Explore the room');

  // 2. Skip removes the onboarding card
  const skipBtn = card.getByRole('button', { name: 'Skip' });
  await skipBtn.click();
  await expect(card).toBeHidden();

  // 3. Tab walk from the body follows the shell's order: header controls, the rail, the canvas,
  // the card (actions, swatches, share), the Light Control button then the panel, the footer.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.focus();
  });

  // Tab to music switch
  await page.keyboard.press('Tab');
  expect(await focusMatches(page, 'header button.music-switch'), 'activeElement is music switch').toBe(
    true,
  );

  // Tab to first thumbnail
  await page.keyboard.press('Tab');
  expect(await focusMatches(page, '#looks button'), 'activeElement is a thumbnail').toBe(true);

  // Tab through the remaining thumbnails to the canvas
  await tabUntil(page, 'canvas#scene');
  expect(await focusMatches(page, 'canvas#scene'), 'activeElement is canvas').toBe(true);

  // Tab from canvas to action button
  await page.keyboard.press('Tab');
  expect(await focusMatches(page, '.product-card__action'), 'activeElement is an action button').toBe(
    true,
  );

  // 4. The tooltip follows focus and Escape dismisses it
  const rotate = page.locator('.product-card__action[data-action="rotate"]');
  await rotate.focus();
  const tooltip = page.locator('#a11y-tooltip[role="tooltip"]');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText('Turn the look');
  expect(await rotate.getAttribute('aria-describedby'), 'the button points at the tooltip').toBe(
    'a11y-tooltip',
  );
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  expect(await rotate.getAttribute('aria-describedby'), 'the link is gone with the tooltip').toBeNull();

  // Tab through action buttons to swatch
  await tabUntil(page, '.product-card__swatch');
  expect(await focusMatches(page, '.product-card__swatch'), 'activeElement is a swatch').toBe(true);
  const swatchChecked = await page.evaluate(() => document.activeElement?.getAttribute('aria-checked'));
  expect(swatchChecked, 'swatch tab stop is checked').toBe('true');

  // Single tab stop: one Tab leaves the group for the share block, then the Light Control
  // disclosure, then the panel itself. The stops are named one by one; the bounded loop after
  // them keeps a lost focus from turning into a hang.
  await page.keyboard.press('Tab');
  expect(await focusMatches(page, '.product-card__swatch'), 'one Tab leaves the swatch group').toBe(
    false,
  );
  expect(await focusMatches(page, '.share__button--copy'), 'activeElement is Copy link').toBe(true);
  await page.keyboard.press('Tab');
  expect(await focusMatches(page, '.share__button--screenshot'), 'activeElement is Screenshot').toBe(
    true,
  );
  await page.keyboard.press('Tab');
  expect(await focusMatches(page, '#shell-light-toggle'), 'activeElement is Light Control').toBe(
    true,
  );
  expect(
    await page.locator('#shell-light-toggle').getAttribute('aria-expanded'),
    'the disclosure is open at the desktop width',
  ).toBe('true');
  for (let i = 0; i < 4 && !(await focusMatches(page, '.lightpanel input, .lightpanel select')); i += 1) {
    await page.keyboard.press('Tab');
  }
  expect(
    await focusMatches(page, '.lightpanel input, .lightpanel select'),
    'activeElement is a light panel control',
  ).toBe(true);

  // 5. ArrowRight on the checked swatch checks the next one and data-variant follows
  const activeSwatch = page.locator('.product-card__swatch[aria-checked="true"]');
  await activeSwatch.focus();
  await page.keyboard.press('ArrowRight');

  await expect(canvas).toHaveAttribute('data-variant', 'light', { timeout: SWITCH_TIMEOUT });
  const nextChecked = page.locator('.product-card__swatch[aria-label="light"]');
  await expect(nextChecked).toHaveAttribute('aria-checked', 'true');

  // 6. After clicking the third thumbnail the live region text contains the third look's name
  const thumbnails = page.locator('#looks button');
  await thumbnails.nth(2).click();

  const thirdLookName = 'New Look Dress';
  await expect(canvas).toHaveAttribute('data-look', 'new-look-dress', { timeout: SWITCH_TIMEOUT });
  const liveRegion = page.locator('.a11y-live-region');
  await expect(liveRegion).toContainText(thirdLookName, { timeout: 10_000 });

  // 7. The look switch re-renders the swatches; the roving tabindex has to survive that
  const checkedAfterSwitch = page.locator('.product-card__swatch[aria-checked="true"]');
  await expect(checkedAfterSwitch).toHaveAttribute('tabindex', '0');
  const variantBefore = await canvas.getAttribute('data-variant');
  expect(variantBefore, 'the canvas names a variant after the switch').not.toBeNull();
  await checkedAfterSwitch.focus();
  await page.keyboard.press('ArrowRight');
  await expect(canvas).not.toHaveAttribute('data-variant', variantBefore ?? '', {
    timeout: SWITCH_TIMEOUT,
  });
  expect(
    await focusMatches(page, '.product-card__swatch[aria-checked="true"][tabindex="0"]'),
    'the arrow key moved the check, the tab stop and the focus together',
  ).toBe(true);

  // 8. No console message of type error
  expect(consoleErrors, 'no console messages of type error').toHaveLength(0);
});

test('the onboarding card stays away under e2e without the flag', async ({ page }) => {
  skipUnlessWebgl2();

  await page.goto('/?webgl=1&e2e=1');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

  // Other specs run under e2e=1 and must never meet the card.
  await expect(page.locator('.onboarding-card')).toHaveCount(0);
});
