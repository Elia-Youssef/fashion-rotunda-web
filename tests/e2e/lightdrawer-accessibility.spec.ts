import { expect, test } from './support/fixtures';
import { SCENE_READY_TIMEOUT, waitForLoopIdle, waitForSceneInitialization } from './support/ready';
import { waitForTooltipInstallation } from './support/a11y-mount';
import {
  STUDIO_LIGHTS,
  VIEWPORTS,
  assertHitAndSafe,
  setNativeInput,
  newTouchPage,
} from './support/lightdrawer-helpers';
import { openShowroom } from './support/showroom';
import { installSafeArea } from './support/safe-area';

// The drawer and rig checks are backend independent, so both projects run them: each page is
// pinned to its project's backend through the canvas data-backend attribute, and the opening
// waits past the late chrome mount before any DOM reading.
const DRAWER_PATH = '/?gate=off&e2e=1&proof=1&music=off';

// The mouse-open absence window: nothing but wall time proves the focus tooltip never appears
// after a mouse-opened focus, since the tooltip module's :focus-visible check is the behavior
// under test. A wrong show is raised in the focus dispatch itself, so the window only has to let
// a deferred show land, and it is twice the module's longest timer, the 150 ms hover transit delay.
const MOUSE_OPEN_TOOLTIP_QUIET_WINDOW_MS = 300;

test.describe('simplified Light Control drawer and rig', () => {

  test('exact control census, labels, and removed-control absence', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openShowroom(page, request, DRAWER_PATH);
    await page.locator('#shell-light-toggle').click();
    const panel = page.locator('#shell-light-panel');
    await expect(panel.locator('.lightpanel__row')).toHaveCount(4);

    for (const id of STUDIO_LIGHTS) {
      const row = panel.locator(`[data-light="${id}"]`);
      await expect(row).toBeVisible();
      await expect(row.locator('.lightpanel__switch')).toHaveAttribute('type', 'checkbox');
      await expect(row.locator('.lightpanel__range')).toHaveAttribute('min', '0');
      await expect(row.locator('.lightpanel__range')).toHaveAttribute('max', '50');
      await expect(row.locator('.lightpanel__value--intensity')).toContainText('cd');
      await expect(row.locator('.lightpanel__color')).toHaveAttribute('type', 'color');
      await expect(row.locator('.lightpanel__value--color')).toHaveText(/^#[0-9a-f]{6}$/);
      for (const input of await row.locator('input').all()) {
        const inputId = await input.getAttribute('id');
        expect(inputId, `${id} input has an id`).toBeTruthy();
        await expect(page.locator(`label[for="${inputId}"]`)).toHaveCount(1);
      }
      // The desktop bar hides the "Intensity" and "Color" words; the names stay whole.
      const title = await row.locator('legend').textContent();
      await expect(panel.getByRole('checkbox', { name: `${title} Enabled`, exact: true })).toHaveCount(1);
      await expect(panel.getByRole('slider', { name: `${title} Intensity`, exact: true })).toHaveCount(1);
      await expect(panel.getByLabel(`${title} Color`, { exact: true })).toHaveCount(1);
    }
    await expect(panel.getByRole('slider', { name: 'Daylight Atmosphere', exact: true })).toHaveCount(1);

    const daylight = panel.locator('[data-light="daylight"]');
    await expect(daylight.locator('.lightpanel__range--daylight')).toHaveAttribute('min', '0');
    await expect(daylight.locator('.lightpanel__range--daylight')).toHaveAttribute('max', '1');
    await expect(daylight.locator('.lightpanel__range--daylight')).toHaveAttribute('step', '0.01');
    for (const phase of ['Dawn', 'Day', 'Noon']) {
      await expect(daylight.locator('.lightpanel__guidance')).toContainText(phase);
    }
    for (const selector of [
      '[data-light="top"]',
      '[data-light="indirect"]',
      '[data-light="sun"]',
      '[data-light="sky"]',
      '.lightpanel__select',
      '[id*="kelvin"]',
      '[id*="exposure"]',
    ]) {
      await expect(panel.locator(selector), `${selector} is absent`).toHaveCount(0);
    }
  });

  // Opening the bar moves focus to its first control. Keyboard opening shows that control's
  // tooltip; a mouse click must not, or the tooltip covers the Key light title every time.
  test('desktop bar shows the focus tooltip after keyboard opening only', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    await page.setViewportSize({ width: 1440, height: 900 });
    await openShowroom(page, request, DRAWER_PATH);
    // The tooltip module installs after the ready attribute; the mouse-open branch would pass without it.
    await waitForTooltipInstallation(page, SCENE_READY_TIMEOUT);
    const toggle = page.locator('#shell-light-toggle');
    const panel = page.locator('#shell-light-panel');
    const keySwitch = panel.locator('[data-light="key"] .lightpanel__switch');
    const tooltip = page.locator('#a11y-tooltip[role="tooltip"]');

    await toggle.click();
    await expect(panel).toBeVisible();
    await expect(keySwitch).toBeFocused();
    await page.waitForTimeout(MOUSE_OPEN_TOOLTIP_QUIET_WINDOW_MS);
    await expect(tooltip, 'mouse opening shows no focus tooltip').toBeHidden();
    expect(await keySwitch.getAttribute('aria-describedby')).toBeNull();
    await toggle.click();
    await expect(panel).toBeHidden();

    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();
    await expect(keySwitch).toBeFocused();
    await expect(tooltip, 'keyboard opening shows the focus tooltip').toBeVisible();
    await expect(tooltip).toHaveText('Toggle Key light on or off');
    expect(await keySwitch.getAttribute('aria-describedby')).toBe('a11y-tooltip');
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
  });

  for (const viewport of VIEWPORTS.filter((entry) => entry.sheet)) {
    test(`sheet modal semantics preserve rail, Look, and proof hit ownership at ${viewport.width}x${viewport.height}`, async ({
      page,
      request,
    }) => {
      test.setTimeout(120_000);

      await page.setViewportSize(viewport);
      await openShowroom(page, request, DRAWER_PATH);
      await installSafeArea(page);

      const rail = page.locator('#looks');
      const firstRailControl = rail.locator('button').first();
      const measure = page.locator('.proof-panel__measure');
      const lightToggle = page.locator('#shell-light-toggle');
      const lookToggle = page.locator('.shell-pill--look');
      const lightPanel = page.locator('#shell-light-panel');
      const card = page.locator('#shell-card');

      // Closed mode is the only state where the rail coexists with both launchers and Measure.
      await assertHitAndSafe(firstRailControl, viewport, 'closed rail first item');
      await assertHitAndSafe(lightToggle, viewport, 'closed Lights launcher');
      await assertHitAndSafe(lookToggle, viewport, 'closed Look launcher');
      await assertHitAndSafe(measure, viewport, 'closed Measure');

      await lightToggle.click();
      await expect(lightPanel).toBeVisible();
      await expect(rail).toBeHidden();
      const lightRailState = await rail.evaluate((node) => ({
        hidden: (node as HTMLElement).hidden,
        inert: (node as HTMLElement).inert,
        ariaHidden: node.getAttribute('aria-hidden'),
      }));
      expect(lightRailState).toEqual({ hidden: true, inert: true, ariaHidden: 'true' });
      await assertHitAndSafe(measure, viewport, 'open Lights Measure');

      await page.locator('#shell-light-row .shell-sheet__close').click();
      await expect(lightPanel).toBeHidden();
      await expect(rail).toBeVisible();
      await assertHitAndSafe(firstRailControl, viewport, 'restored rail first item');

      await lookToggle.focus();
      await page.keyboard.press('Enter');
      await expect(card).toBeVisible();
      await expect(card.locator('.shell-sheet__close')).toBeFocused();
      await expect(rail).toBeHidden();
      const lookRailState = await rail.evaluate((node) => ({
        hidden: (node as HTMLElement).hidden,
        inert: (node as HTMLElement).inert,
        ariaHidden: node.getAttribute('aria-hidden'),
      }));
      expect(lookRailState).toEqual({ hidden: true, inert: true, ariaHidden: 'true' });
      await assertHitAndSafe(measure, viewport, 'open Look Measure');

      await page.keyboard.press('Escape');
      await expect(card).toBeHidden();
      await expect(lookToggle).toBeFocused();
      await expect(rail).toBeVisible();
      await assertHitAndSafe(firstRailControl, viewport, 'post-Escape rail first item');
      await waitForLoopIdle(page);

    });
  }

  test('keyboard, pointer, native inputs, persistence, share state, and idle', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    await page.setViewportSize({ width: 1440, height: 900 });
    await openShowroom(page, request, DRAWER_PATH);
    const toggle = page.locator('#shell-light-toggle');
    const panel = page.locator('#shell-light-panel');

    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();
    const keySwitch = panel.locator('[data-light="key"] .lightpanel__switch');
    await expect(keySwitch).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expect(panel).toBeHidden();
    await page.keyboard.press('Space');
    await expect(panel).toBeVisible();
    await expect(keySwitch).toBeFocused();

    await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);
    const initialRig = await page.evaluate(() => window.archvizE2E?.rigState() ?? null);
    expect(initialRig).toMatch(/^v2;/);
    await page.keyboard.press('Space');
    await expect(keySwitch).not.toBeChecked();

    const keyRange = panel.locator('[data-light="key"] .lightpanel__range');
    await keyRange.focus();
    const rangeBefore = Number(await keyRange.inputValue());
    await page.keyboard.press('ArrowRight');
    expect(Number(await keyRange.inputValue())).toBeGreaterThan(rangeBefore);

    const fillColor = panel.locator('[data-light="fill"] .lightpanel__color');
    await setNativeInput(fillColor, '#123456');
    await expect(fillColor).toHaveValue('#123456');
    await expect(panel.locator('[data-light="fill"] .lightpanel__value--color')).toHaveText(
      '#123456',
    );
    const daylight = panel.locator('.lightpanel__range--daylight');
    await setNativeInput(daylight, '0.2');
    await expect(daylight).toHaveValue('0.2');

    const changedRig = await page.evaluate(() => window.archvizE2E?.rigState() ?? null);
    expect(changedRig).not.toBe(initialRig);
    expect(changedRig).toContain('key,0,15.5,ffffff');
    expect(changedRig).toContain('fill,0,7,123456');
    expect(changedRig).toContain('day,0.2');
    await expect.poll(() => new URL(page.url()).searchParams.get('rig')).toBe(changedRig);

    await toggle.click();
    await expect(panel).toBeHidden();
    expect(
      await panel.locator('input').evaluateAll((inputs) =>
        inputs.every((input) => !input.matches(':focus')),
      ),
    ).toBe(true);
    await toggle.click();
    await expect(keySwitch).not.toBeChecked();
    await expect(keyRange).toHaveValue('15.5');
    await expect(fillColor).toHaveValue('#123456');
    await expect(daylight).toHaveValue('0.2');

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(toggle).toBeFocused();
    await waitForLoopIdle(page);
  });

  test('closed drawer preserves card, rail, Measure, music, and responsive focus continuity', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    await page.setViewportSize({ width: 1440, height: 900 });
    await openShowroom(page, request, DRAWER_PATH);
    const toggle = page.locator('#shell-light-toggle');
    const panel = page.locator('#shell-light-panel');
    await expect(panel).toBeHidden();

    for (const [label, locator] of [
      ['rail first item', page.locator('#looks button').first()],
      ['card Rotate', page.locator('.product-card__action[data-action="rotate"]')],
      ['Measure', page.locator('.proof-panel__measure')],
      ['music', page.locator('header button.music-switch')],
    ] as const) {
      await expect(locator, `${label} is visible`).toBeVisible();
      const hit = await locator.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const owner = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return owner === node || node.contains(owner);
      });
      expect(hit, `${label} owns its center while drawer is closed`).toBe(true);
    }

    await toggle.click();
    await expect(panel).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel).toBeHidden();
    await expect(toggle).toBeFocused();
    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(panel).toBeHidden();
  });

  test('touchscreen tap opens and closes the phone drawer', async ({ guardedBrowser: browser }) => {
    const touch = await newTouchPage(browser);
    try {
      await openShowroom(touch.page, touch.context.request, DRAWER_PATH);
      const toggle = touch.page.locator('#shell-light-toggle');
      const box = await toggle.boundingBox();
      expect(box).not.toBeNull();
      if (box === null) return;
      await touch.page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await expect(touch.page.locator('#shell-light-panel')).toBeVisible();
      const close = touch.page.locator('#shell-light-row .shell-sheet__close');
      const closeBox = await close.boundingBox();
      expect(closeBox).not.toBeNull();
      if (closeBox === null) return;
      await touch.page.touchscreen.tap(
        closeBox.x + closeBox.width / 2,
        closeBox.y + closeBox.height / 2,
      );
      await expect(touch.page.locator('#shell-light-panel')).toBeHidden();

    } finally {
      await touch.context.close();
    }
  });

  test('phone reduced motion removes sheet movement from the rendered drawer', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openShowroom(page, request, DRAWER_PATH);
    await page.locator('#shell-light-toggle').click();
    await expect(page.locator('#shell-light-panel')).toBeVisible();

    const motion = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const row = document.querySelector<HTMLElement>('#shell-light-row');
      const panel = document.querySelector<HTMLElement>('#shell-light-panel');
      if (row === null || panel === null) throw new Error('light sheet is unavailable');
      const rowStyle = getComputedStyle(row);
      const panelStyle = getComputedStyle(panel);
      return {
        tokens: [
          root.getPropertyValue('--dur-fast').trim(),
          root.getPropertyValue('--dur-base').trim(),
        ],
        row: { transition: rowStyle.transitionDuration, animation: rowStyle.animationDuration },
        panel: { transition: panelStyle.transitionDuration, animation: panelStyle.animationDuration },
      };
    });
    // Browsers canonicalize a zero CSS custom-property duration inconsistently (the authored
    // reduced-motion override is `0ms`, while Chromium serializes it here as `0s`). Either
    // spelling proves the value is zero; a non-zero value would animate the phone sheet.
    expect(motion.tokens).toEqual(['0s', '0s']);
    for (const duration of [
      motion.row.transition,
      motion.row.animation,
      motion.panel.transition,
      motion.panel.animation,
    ]) {
      expect(['0s', '0ms', '0s, 0s']).toContain(duration);
    }
  });
});
