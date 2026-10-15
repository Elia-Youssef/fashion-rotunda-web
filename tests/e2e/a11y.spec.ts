import { expect, test } from './support/fixtures';
import type { Page } from '@playwright/test';
import { waitForTooltipInstallation } from './support/a11y-mount';
import { backendPath, projectBackend } from './support/backend';
import { openShowroom } from './support/showroom';

// Onboarding, tooltips and accessibility pass.
// Tests the first-visit onboarding card, Skip dismissal, the DOM tab walk order,
// roving tabindex arrow navigation on swatches, the tooltip on focus, live region announcements
// on look changes, and ensures no console errors occur.
// The checks are backend independent, so both projects run them; each page is pinned to its
// project's backend through the canvas data-backend attribute before any DOM reading.

const SCENE_READY_TIMEOUT = 60_000;
const SWITCH_TIMEOUT = 30_000;
// The a11y module mounts after the ready attribute is published (after compilation and the first
// drawn frame), so its waits use the scene-initialization budget instead of the assertion default.
const A11Y_MOUNT_TIMEOUT = SCENE_READY_TIMEOUT;
const SAFE_AREA = { top: 19, right: 23, bottom: 29, left: 17 } as const;

// The longest run in the documented order is the thumbnail strip, seven looks plus the controls
// around it. Twelve presses cover it; an unbounded loop would hang instead of failing.
const MAX_TAB_PRESSES = 12;

function boxesIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

async function installSafeArea(page: Page): Promise<void> {
  await page.evaluate((insets) => {
    const root = document.documentElement;
    root.style.setProperty('--safe-area-top', `${insets.top}px`);
    root.style.setProperty('--safe-area-right', `${insets.right}px`);
    root.style.setProperty('--safe-area-bottom', `${insets.bottom}px`);
    root.style.setProperty('--safe-area-left', `${insets.left}px`);
  }, SAFE_AREA);
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

test('onboarding sequence, focus order, swatch navigation and live announcements', async ({
  page,
  request,
}) => {
  // Six steps on a software-rendered page: the suite's default minute ran out under load.
  test.setTimeout(120_000);

  const { canvas } = await openShowroom(page, request, '/?gate=off&onboarding=reset');
  await expect(page.locator('button[data-mode="walk"]')).toBeEnabled({ timeout: 10_000 });

  // 1. Onboarding card appears with the first step; the a11y mount follows the ready attribute.
  const card = page.locator('.onboarding-card');
  await expect(card).toBeVisible({ timeout: A11Y_MOUNT_TIMEOUT });
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

  // Tab through both camera modes, then to the first thumbnail.
  await page.keyboard.press('Tab');
  expect(await focusMatches(page, 'button[data-mode="orbit"]'), 'activeElement is Orbit').toBe(true);
  await page.keyboard.press('Tab');
  expect(await focusMatches(page, 'button[data-mode="walk"]'), 'activeElement is Walk').toBe(true);
  await page.keyboard.press('Tab');
  expect(await focusMatches(page, '#looks button'), 'activeElement is a thumbnail').toBe(true);

  // Tab through the remaining thumbnails to the canvas
  await tabUntil(page, 'canvas#scene');
  expect(await focusMatches(page, 'canvas#scene'), 'activeElement is canvas').toBe(true);

  // Tab from canvas to the look's Source link, then to an action button
  await page.keyboard.press('Tab');
  expect(await focusMatches(page, '.product-card__source'), 'activeElement is the Source link').toBe(
    true,
  );
  await page.keyboard.press('Tab');
  expect(await focusMatches(page, '.product-card__action'), 'activeElement is an action button').toBe(
    true,
  );

  // 4. The tooltip follows focus and Escape dismisses it
  const rotate = page.locator('.product-card__action[data-action="rotate"]');
  await rotate.focus();
  const tooltip = page.locator('#a11y-tooltip[role="tooltip"]');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText('Rotate the look');
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
    'the disclosure starts closed at the desktop width',
  ).toBe('false');
  // The drawer opens through the same disclosure, then its controls are one Tab away.
  await page.locator('#shell-light-toggle').click();
  await expect(page.locator('#shell-light-toggle')).toHaveAttribute('aria-expanded', 'true');
  for (let i = 0; i < 4 && !(await focusMatches(page, '.lightpanel input, .lightpanel select')); i += 1) {
    await page.keyboard.press('Tab');
  }
  expect(
    await focusMatches(page, '.lightpanel input, .lightpanel select'),
    'activeElement is a light panel control',
  ).toBe(true);

  // Escape dismisses the shell disclosure as well as transient tooltips, and returns the tab
  // sequence to the button that opened it rather than leaving focus in hidden panel content.
  await page.keyboard.press('Escape');
  await expect(page.locator('#shell-light-panel')).toBeHidden();
  expect(await focusMatches(page, '#shell-light-toggle'), 'Escape returns to Light Control').toBe(
    true,
  );

  // 5. ArrowRight on the checked swatch checks the next one and data-variant follows
  const activeSwatch = page.locator('.product-card__swatch[aria-checked="true"]');
  await activeSwatch.focus();
  await page.keyboard.press('ArrowRight');

  await expect(canvas).toHaveAttribute('data-variant', 'light', { timeout: SWITCH_TIMEOUT });
  const nextChecked = page.locator('.product-card__swatch[aria-label="Light"]');
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
});

test('the onboarding card stays away under e2e without the flag', async ({ page, request }) => {
  await openShowroom(page, request, '/?e2e=1');

  // Other specs run under e2e=1 and must never meet the card. Two assertions: the a11y mount
  // decides onboarding and must be installed first, then the card is asserted absent.
  await waitForTooltipInstallation(page, A11Y_MOUNT_TIMEOUT);
  await expect(page.locator('.onboarding-card')).toHaveCount(0);
});

test('the long GPU tooltip stays inside short landscape and dismisses without stale ARIA', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 844, height: 390 });
  await openShowroom(page, request, '/?e2e=1&gate=off');

  const badge = page.locator('.badge');
  const tooltip = page.locator('#a11y-tooltip[role="tooltip"]');
  // The tooltip listeners install with the a11y module after the ready attribute; an earlier hover is lost.
  await waitForTooltipInstallation(page, A11Y_MOUNT_TIMEOUT);
  await badge.hover();
  await expect(tooltip).toBeVisible();
  const box = await tooltip.boundingBox();
  expect(box, 'GPU tooltip has a viewport box').not.toBeNull();
  if (box !== null) {
    expect(box.x, 'GPU tooltip clears the left viewport edge').toBeGreaterThanOrEqual(0);
    expect(box.y, 'GPU tooltip clears the top viewport edge').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'GPU tooltip clears the right viewport edge').toBeLessThanOrEqual(844);
    expect(box.y + box.height, 'GPU tooltip clears the bottom viewport edge').toBeLessThanOrEqual(390);
  }

  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
  expect(await badge.getAttribute('aria-describedby')).toBeNull();
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 820, height: 1180 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  test(`the onboarding Lights step leaves its launcher usable at ${viewport.width}x${viewport.height}`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await openShowroom(page, request, '/?gate=off&onboarding=reset');
    await installSafeArea(page);

    const card = page.locator('.onboarding-card');
    // Onboarding mounts with the a11y module after the ready attribute is published.
    await expect(card).toBeVisible({ timeout: A11Y_MOUNT_TIMEOUT });
    await card.getByRole('button', { name: 'Next' }).click();
    await card.getByRole('button', { name: 'Next' }).click();
    await expect(card.locator('.onboarding-card__title')).toHaveText('Adjust lighting');

    const launcher = page.locator('#shell-light-toggle');
    await expect(launcher).toBeVisible();
    const cardBox = await card.boundingBox();
    const launcherBox = await launcher.boundingBox();
    expect(cardBox, 'the Lights guide has a box').not.toBeNull();
    expect(launcherBox, 'the Light Control launcher has a box').not.toBeNull();
    if (cardBox !== null && launcherBox !== null) {
      expect(
        boxesIntersect(cardBox, launcherBox),
        'the guide does not cover its Light Control target',
      ).toBe(false);
      expect(launcherBox.x, 'the launcher clears the left safe inset').toBeGreaterThanOrEqual(
        SAFE_AREA.left,
      );
      expect(launcherBox.y, 'the launcher clears the top safe inset').toBeGreaterThanOrEqual(
        SAFE_AREA.top,
      );
      expect(
        launcherBox.x + launcherBox.width,
        'the launcher clears the right safe inset',
      ).toBeLessThanOrEqual(viewport.width - SAFE_AREA.right);
      expect(
        launcherBox.y + launcherBox.height,
        'the launcher clears the bottom safe inset',
      ).toBeLessThanOrEqual(viewport.height - SAFE_AREA.bottom);
      expect(launcherBox.width, 'the launcher is a 44px target').toBeGreaterThanOrEqual(44);
      expect(launcherBox.height, 'the launcher is a 44px target').toBeGreaterThanOrEqual(44);
    }

    const launcherHit = await launcher.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === node || node.contains(hit);
    });
    expect(launcherHit, 'the onboarding Lights anchor owns its actionable point').toBe(true);

    await launcher.click();
    await expect(launcher).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#shell-light-panel')).toBeVisible();
  });
}

test('transition manages inert state, focus transfer, and live announcements during reveal', async ({
  page,
}) => {
  test.setTimeout(120_000);

  await page.goto(backendPath('/'));
  const lobby = page.locator('#entry-lobby');
  const header = page.locator('#shell-header');
  const main = page.locator('main');
  const footer = page.locator('footer');

  // Before load: shell roots are inert and hidden from assistive technology
  await expect(lobby).toHaveAttribute('data-state', 'idle');
  await expect(header).toHaveAttribute('inert', '');
  await expect(header).toHaveAttribute('aria-hidden', 'true');
  await expect(main).toHaveAttribute('inert', '');
  await expect(main).toHaveAttribute('aria-hidden', 'true');
  await expect(footer).toHaveAttribute('inert', '');
  await expect(footer).toHaveAttribute('aria-hidden', 'true');

  // Trigger load
  await lobby.locator('#lobby-load-btn').click();

  // Wait for revealed state
  await expect(lobby).toHaveCount(0, { timeout: 60_000 });
  // The renderer starts with the load action, so only now can the page be pinned to the backend
  // its project promises; a silent fallback would make the reveal checks read the wrong build.
  await expect(page.locator('canvas#scene')).toHaveAttribute('data-backend', projectBackend(), {
    timeout: SCENE_READY_TIMEOUT,
  });
  await expect(lobby).toBeHidden();

  // After reveal: inert attributes removed
  await expect(header).not.toHaveAttribute('inert');
  await expect(header).not.toHaveAttribute('aria-hidden');
  await expect(main).not.toHaveAttribute('inert');
  await expect(main).not.toHaveAttribute('aria-hidden');
  await expect(footer).not.toHaveAttribute('inert');
  await expect(footer).not.toHaveAttribute('aria-hidden');

  // Safe semantic focus target: main received focus, or onboarding card if onboarding is active
  const activeTarget = await page.evaluate(() => {
    const el = document.activeElement;
    if (el === document.querySelector('main')) return 'main';
    if (el?.classList.contains('onboarding-card')) return 'onboarding-card';
    return el?.tagName.toLowerCase() ?? '';
  });
  expect(['main', 'onboarding-card'], 'safe focus target after reveal').toContain(activeTarget);

  // Announcer announced readiness
  const announcer = page.locator('.a11y-live-region');
  await expect(announcer).toContainText('Experience ready');
});

test('prefers-reduced-motion bypasses decorative fading during transition', async ({ page }) => {
  test.setTimeout(120_000);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(backendPath('/'));

  const lobby = page.locator('#entry-lobby');
  await expect(lobby).toHaveAttribute('data-state', 'idle');

  await lobby.locator('#lobby-load-btn').click();

  // Reaches revealed state successfully
  await expect(lobby).toHaveCount(0, { timeout: 60_000 });
  // Same pin as the transition test: the renderer exists only after the load action.
  await expect(page.locator('canvas#scene')).toHaveAttribute('data-backend', projectBackend(), {
    timeout: SCENE_READY_TIMEOUT,
  });
  await expect(lobby).toBeHidden();
  await expect(page.locator('#scene-veil')).toBeHidden();
  await expect(page.locator('#shell-header')).not.toHaveAttribute('inert');
});
