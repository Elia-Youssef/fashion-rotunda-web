import { expect, test } from './support/fixtures';
import { waitForSceneInitialization } from './support/ready';
import { assertCanvasPreserved, nextProofReading } from './support/preservation';
import { openShowroom } from './support/showroom';
import type { Locator } from '@playwright/test';
import { installSafeArea } from './support/safe-area';
import {
  SCENE_READY_TIMEOUT,
  STUDIO_LIGHTS,
  VIEWPORTS,
  DESKTOP_BAR_VIEWPORTS,
  assertHitAndSafe,
  readDesktopBar,
} from './support/lightdrawer-helpers';

// Every case here reads DOM, geometry, target sizes or preserved canvas identity, none of which
// the backend changes, so both projects run the file and each page is pinned to its project's
// backend through the canvas data-backend attribute before any reading. The proof panel is on in
// production only with proof=1, e2e=1 exposes the handles the proof readings need, and music=off
// keeps the drawer timings free of the audio unlock.
const DRAWER_OPEN_PATH = '/?gate=off&e2e=1&proof=1&music=off';

test.describe('simplified Light Control drawer and rig', () => {
  for (const viewport of VIEWPORTS) {
    test(`closed/open contract and preservation at ${viewport.name} ${viewport.width}x${viewport.height}`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize(viewport);
      await openShowroom(page, request, DRAWER_OPEN_PATH);
      const toggle = page.locator('#shell-light-toggle');
      const panel = page.locator('#shell-light-panel');
      await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);
      const before = (await nextProofReading(page)).canvas;

      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(panel).toBeHidden();
      expect(
        await panel.locator('input').evaluateAll((inputs) =>
          inputs.every((input) => !input.matches(':focus')),
        ),
      ).toBe(true);

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(panel).toBeVisible();
      await expect(panel.locator('[data-light]')).toHaveCount(4);
      const after = (await nextProofReading(page)).canvas;
      assertCanvasPreserved(before, after, 'opening');

      if (viewport.sheet) await page.locator('#shell-light-row .shell-sheet__close').click();
      else await toggle.click();
      await expect(panel).toBeHidden();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      assertCanvasPreserved(before, (await nextProofReading(page)).canvas, 'closing');

    });
  }

  // The 44 px rule holds wherever the drawer is a sheet or the tablet drawer. The desktop bar is
  // compact on a fine pointer (24 px, tested below) and keeps 44 px on a coarse one.
  for (const viewport of VIEWPORTS.filter((entry) => entry.sheet || entry.name === 'tablet')) {
    test(`safe-area, 44px and hit ownership for every control at ${viewport.width}x${viewport.height}`, async ({
      page,
      request,
    }) => {
      test.setTimeout(120_000);

      await page.setViewportSize(viewport);
      await openShowroom(page, request, DRAWER_OPEN_PATH);
      await installSafeArea(page);
      const toggle = page.locator('#shell-light-toggle');
      await assertHitAndSafe(toggle, viewport, 'closed launcher');
      await toggle.click();
      const panel = page.locator('#shell-light-panel');
      await expect(panel).toBeVisible();

      const controls: Array<[string, Locator]> = viewport.sheet
        ? [['close', page.locator('#shell-light-row .shell-sheet__close')]]
        : [];
      for (const id of STUDIO_LIGHTS) {
        const row = panel.locator(`[data-light="${id}"]`);
        controls.push(
          [`${id} checkbox`, row.locator('.lightpanel__switch')],
          [`${id} range`, row.locator('.lightpanel__range')],
          [`${id} color`, row.locator('.lightpanel__color')],
        );
      }
      controls.push(['daylight range', panel.locator('.lightpanel__range--daylight')]);
      for (const [label, control] of controls) await assertHitAndSafe(control, viewport, label);

      const scrollProof = await panel.evaluate((node) => {
        const element = node as HTMLElement;
        element.scrollTop = 0;
        const first = element.scrollTop;
        element.scrollTop = element.scrollHeight;
        return {
          first,
          last: element.scrollTop,
          maximum: element.scrollHeight - element.clientHeight,
          internallyScrollable: element.scrollHeight > element.clientHeight,
        };
      });
      if (scrollProof.internallyScrollable) {
        expect(scrollProof.first, 'first internal scroll position').toBe(0);
        expect(scrollProof.last, 'last internal scroll position').toBe(scrollProof.maximum);
      }
      await assertHitAndSafe(
        panel.locator('[data-light="key"] .lightpanel__switch'),
        viewport,
        'first scrollable control',
      );
      await assertHitAndSafe(
        panel.locator('.lightpanel__range--daylight'),
        viewport,
        'last scrollable control',
      );

    });
  }

  // At desktop size the drawer is the Unreal panel's one bar
  // beside the launcher. On a fine pointer its controls are compact, with a 24 px desktop minimum:
  // every target keeps the 24 px WCAG 2.5.8 floor and owns its centre. The bar stays inside the
  // bottom 140 px the rail leaves free, and it opens
  // right of the rail, which is what keeps the two apart when a coarse pointer makes it taller.
  for (const viewport of DESKTOP_BAR_VIEWPORTS) {
    test(`desktop fine-pointer bar at ${viewport.width}x${viewport.height}: four columns, 24px targets, no overlap`, async ({
      page,
      request,
    }) => {
      test.setTimeout(120_000);

      await page.setViewportSize(viewport);
      await openShowroom(page, request, DRAWER_OPEN_PATH);
      expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches), 'fine pointer').toBe(true);
      const toggle = page.locator('#shell-light-toggle');
      const closedToggle = await toggle.boundingBox();
      await toggle.click();
      const panel = page.locator('#shell-light-panel');
      await expect(panel).toBeVisible();
      const bar = await readDesktopBar(page);

      expect(bar.toggle, 'opening does not move the launcher').toEqual(closedToggle);
      expect(bar.panel.left, 'the bar opens right of the launcher').toBeGreaterThanOrEqual(
        bar.toggle.x + bar.toggle.width,
      );
      expect(Math.abs(bar.panel.bottom - (bar.toggle.y + bar.toggle.height)), 'bottom-aligned').toBeLessThanOrEqual(1);
      expect(viewport.height - bar.panel.top, 'the bar stays in the bottom 140 px').toBeLessThanOrEqual(140);
      const rail = await page.locator('#looks').boundingBox();
      expect(rail, 'the rail exists on the page').not.toBeNull();
      expect(bar.panel.left, 'the bar opens right of the rail').toBeGreaterThan((rail?.x ?? 0) + (rail?.width ?? 0));
      expect(bar.scroll.height, 'no internal vertical scroll').toBeLessThanOrEqual(bar.scroll.clientHeight);
      expect(bar.scroll.width, 'no internal horizontal scroll').toBeLessThanOrEqual(bar.scroll.clientWidth);
      expect(bar.columns, 'four columns in one row').toHaveLength(4);
      for (const column of bar.columns) {
        expect(column.top, `${column.light} column shares the bar's row`).toBeCloseTo(bar.columns[0].top, 0);
        expect(column.left, `${column.light} column is inside the bar`).toBeGreaterThanOrEqual(bar.panel.left);
        expect(column.right, `${column.light} column is inside the bar`).toBeLessThanOrEqual(bar.panel.right);
      }
      for (const [name, overlaps] of Object.entries(bar.overlaps)) {
        expect(overlaps, `the ${name} exists on the page`).not.toBeNull();
        expect(overlaps, `the open bar does not overlap the ${name}`).toBe(false);
      }
      for (const control of bar.controls) {
        expect(control.width, `${control.id}: 24px wide`).toBeGreaterThanOrEqual(24);
        expect(control.height, `${control.id}: 24px tall`).toBeGreaterThanOrEqual(24);
        expect(control.hit, `${control.id}: owns its centre; hit ${control.hitName}`).toBe(true);
        expect(control.bottom, `${control.id}: inside the viewport`).toBeLessThanOrEqual(viewport.height);
      }

    });
  }

  test('desktop coarse-pointer bar keeps 44px targets with every column visible', async ({
    guardedBrowser: browser,
    request,
  }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
      baseURL: 'http://localhost:4173',
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      hasTouch: true,
    });
    const page = await context.newPage();

    try {
      await openShowroom(page, request, DRAWER_OPEN_PATH);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'coarse pointer').toBe(true);
      const toggle = page.locator('#shell-light-toggle');
      const closedToggle = await toggle.boundingBox();
      await toggle.click();
      await expect(page.locator('#shell-light-panel')).toBeVisible();
      const bar = await readDesktopBar(page);
      expect(bar.toggle, 'opening does not move the launcher').toEqual(closedToggle);
      expect(bar.scroll.height, 'no internal vertical scroll').toBeLessThanOrEqual(bar.scroll.clientHeight);
      expect(bar.columns).toHaveLength(4);
      // The coarse bar is taller than the rail's 140 px reserve; it stays clear because it opens
      // right of the rail.
      const rail = await page.locator('#looks').boundingBox();
      expect(rail, 'the rail exists on the page').not.toBeNull();
      expect(bar.panel.left, 'the bar opens right of the rail').toBeGreaterThan((rail?.x ?? 0) + (rail?.width ?? 0));
      for (const [name, overlaps] of Object.entries(bar.overlaps)) {
        expect(overlaps, `the ${name} exists on the page`).not.toBeNull();
        expect(overlaps, `the open bar does not overlap the ${name}`).toBe(false);
      }
      for (const control of bar.controls) {
        expect(control.width, `${control.id}: 44px wide`).toBeGreaterThanOrEqual(44);
        expect(control.height, `${control.id}: 44px tall`).toBeGreaterThanOrEqual(44);
        expect(control.hit, `${control.id}: owns its centre; hit ${control.hitName}`).toBe(true);
      }

    } finally {
      await context.close();
    }
  });

  test('desktop forced colours keep native controls at 24px with hit ownership', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ forcedColors: 'active' });
    await openShowroom(page, request, DRAWER_OPEN_PATH);
    await page.locator('#shell-light-toggle').click();
    const panel = page.locator('#shell-light-panel');
    await expect(panel).toBeVisible();
    const appearances = await panel.evaluate((node) =>
      [...node.querySelectorAll<HTMLInputElement>('.lightpanel__switch, .lightpanel__range')].map(
        (input) => getComputedStyle(input).appearance,
      ),
    );
    expect(appearances.length).toBe(7);
    for (const appearance of appearances) expect(appearance, 'native drawing returns').toBe('auto');
    const bar = await readDesktopBar(page);
    expect(bar.scroll.height, 'no internal vertical scroll').toBeLessThanOrEqual(bar.scroll.clientHeight);
    for (const control of bar.controls) {
      expect(control.width, `${control.id}: 24px wide`).toBeGreaterThanOrEqual(24);
      expect(control.height, `${control.id}: 24px tall`).toBeGreaterThanOrEqual(24);
      expect(control.hit, `${control.id}: owns its centre; hit ${control.hitName}`).toBe(true);
    }
  });
});
