import { expect, test } from '@playwright/test';
import { waitForLoopIdle, waitForSceneInitialization } from './support/ready';
import { waitForTooltipInstallation } from './support/a11y-mount';
import { assertCanvasPreserved, nextProofReading, stableDrawCalls } from './support/preservation';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';

const SCENE_READY_TIMEOUT = 60_000;
const SAFE_AREA = { top: 19, right: 23, bottom: 29, left: 17 } as const;
const STUDIO_LIGHTS = ['key', 'fill', 'back'] as const;
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, sheet: false },
  { name: 'tablet', width: 820, height: 1180, sheet: false },
  { name: 'phone', width: 390, height: 844, sheet: true },
  { name: 'short-landscape', width: 844, height: 390, sheet: true },
] as const;

// The desktop bar matrix: the client's window (1669x1115 CSS), the common laptop sizes, and the
// smallest window that still gets the desktop layout.
const DESKTOP_BAR_VIEWPORTS = [
  { width: 1669, height: 1115 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 720 },
  { width: 1200, height: 640 },
] as const;

interface BarControl {
  id: string;
  width: number;
  height: number;
  bottom: number;
  hit: boolean;
  hitName: string;
}

interface DesktopBar {
  toggle: { x: number; y: number; width: number; height: number };
  panel: { left: number; top: number; right: number; bottom: number };
  scroll: { height: number; clientHeight: number; width: number; clientWidth: number };
  columns: Array<{ light: string; top: number; left: number; right: number }>;
  /** null when the selector matched nothing, which the tests treat as a failure. */
  overlaps: Record<string, boolean | null>;
  controls: BarControl[];
}

interface ErrorLog {
  console: string[];
  page: string[];
}

function skipUnlessWebgl2(): void {
  test.skip(test.info().project.name !== 'webgl2', 'DOM behavior is covered once on WebGL2');
}

function watchErrors(page: Page): ErrorLog {
  const errors: ErrorLog = { console: [], page: [] };
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text());
  });
  page.on('pageerror', (error) => errors.page.push(error.message));
  return errors;
}

function expectNoErrors(errors: ErrorLog): void {
  expect(errors.console, 'no console errors').toEqual([]);
  expect(errors.page, 'no uncaught page errors').toEqual([]);
}

async function openScene(
  page: Page,
  path = '/?webgl=1&gate=off&e2e=1&proof=1&music=off',
): Promise<Locator> {
  await page.goto(path);
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  return canvas;
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

async function assertHitAndSafe(
  locator: Locator,
  viewport: { width: number; height: number },
  label: string,
): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const reading = await locator.evaluate((node) => {
    const element = node as HTMLElement;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      hit: hit === element || element.contains(hit),
      hitName: `${hit?.tagName ?? 'null'}#${(hit as HTMLElement | null)?.id ?? ''}.${String((hit as HTMLElement | null)?.className ?? '')}`,
    };
  });

  expect(reading.rect.left, `${label}: clears left safe inset`).toBeGreaterThanOrEqual(
    SAFE_AREA.left,
  );
  expect(reading.rect.top, `${label}: clears top safe inset`).toBeGreaterThanOrEqual(SAFE_AREA.top);
  expect(reading.rect.right, `${label}: clears right safe inset`).toBeLessThanOrEqual(
    viewport.width - SAFE_AREA.right,
  );
  expect(reading.rect.bottom, `${label}: clears bottom safe inset`).toBeLessThanOrEqual(
    viewport.height - SAFE_AREA.bottom,
  );
  expect(reading.rect.width, `${label}: has a 44px pointer width`).toBeGreaterThanOrEqual(44);
  expect(reading.rect.height, `${label}: has a 44px pointer height`).toBeGreaterThanOrEqual(44);
  expect(reading.hit, `${label}: center belongs to the control; hit ${reading.hitName}`).toBe(true);
}

/** The open desktop bar: its box, columns, controls, and whether it touches the other chrome. */
async function readDesktopBar(page: Page): Promise<DesktopBar> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('#shell-light-panel');
    const toggle = document.querySelector<HTMLElement>('#shell-light-toggle');
    if (panel === null || toggle === null) throw new Error('light row is unavailable');
    const box = panel.getBoundingClientRect();
    const toggleBox = toggle.getBoundingClientRect();
    const intersects = (other: Element | null): boolean | null => {
      if (other === null) return null;
      const r = other.getBoundingClientRect();
      return box.left < r.right && r.left < box.right && box.top < r.bottom && r.top < box.bottom;
    };
    return {
      toggle: { x: toggleBox.x, y: toggleBox.y, width: toggleBox.width, height: toggleBox.height },
      panel: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      scroll: {
        height: panel.scrollHeight,
        clientHeight: panel.clientHeight,
        width: panel.scrollWidth,
        clientWidth: panel.clientWidth,
      },
      columns: [...panel.querySelectorAll<HTMLElement>('.lightpanel__row')].map((row) => {
        const r = row.getBoundingClientRect();
        return { light: row.dataset.light ?? '', top: r.top, left: r.left, right: r.right };
      }),
      overlaps: {
        rail: intersects(document.querySelector('#looks')),
        card: intersects(document.querySelector('#shell-card')),
        badge: intersects(document.querySelector('.badge')),
        'proof strip': intersects(document.querySelector('#shell-proof')),
        'music switch': intersects(document.querySelector('header button.music-switch')),
        'mode switch': intersects(document.querySelector('.archviz-mode-switch')),
      },
      controls: [...panel.querySelectorAll<HTMLInputElement>('input')].map((input) => {
        const r = input.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          id: input.id,
          width: r.width,
          height: r.height,
          bottom: r.bottom,
          hit: hit === input || input.contains(hit),
          hitName: `${hit?.tagName ?? 'null'}#${(hit as HTMLElement | null)?.id ?? ''}`,
        };
      }),
    };
  });
}

async function setNativeInput(locator: Locator, value: string): Promise<void> {
  await locator.evaluate((node, next) => {
    const input = node as HTMLInputElement;
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function expectRigAndUrl(page: Page, expected: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.archvizE2E?.rigState() ?? null), { timeout: 30_000 })
    .toBe(expected);
  await expect.poll(() => new URL(page.url()).searchParams.get('rig'), { timeout: 30_000 }).toBe(expected);
}

async function expectDefaultRigWithoutUrl(page: Page, expected: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.archvizE2E?.rigState() ?? null), { timeout: 30_000 })
    .toBe(expected);
  await expect.poll(() => new URL(page.url()).searchParams.get('rig'), { timeout: 30_000 }).toBeNull();
}

async function proofDrawCalls(page: Page): Promise<number | null> {
  return await page.evaluate(() => {
    const term = [...document.querySelectorAll<HTMLElement>('.proof-panel__term')].find(
      (node) => node.textContent === 'draw calls',
    );
    const match = term?.nextElementSibling?.textContent?.match(/^(\d+) calls$/);
    return match === undefined || match === null ? null : Number(match[1]);
  });
}

async function newTouchPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: 'http://localhost:4173',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
  });
  return { context, page: await context.newPage() };
}

test.describe('simplified Light Control drawer and rig', () => {
  for (const viewport of VIEWPORTS) {
    test(`closed/open contract and preservation at ${viewport.name} ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      skipUnlessWebgl2();
      const errors = watchErrors(page);
      await page.setViewportSize(viewport);
      await openScene(page);
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
      expectNoErrors(errors);
    });
  }

  test('exact control census, labels, and removed-control absence', async ({ page }) => {
    skipUnlessWebgl2();
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScene(page);
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
    expectNoErrors(errors);
  });

  // The 44 px rule holds wherever the drawer is a sheet or the tablet drawer. The desktop bar is
  // compact on a fine pointer (24 px, tested below) and keeps 44 px on a coarse one.
  for (const viewport of VIEWPORTS.filter((entry) => entry.sheet || entry.name === 'tablet')) {
    test(`safe-area, 44px and hit ownership for every control at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      skipUnlessWebgl2();
      test.setTimeout(120_000);
      const errors = watchErrors(page);
      await page.setViewportSize(viewport);
      await openScene(page);
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
      expectNoErrors(errors);
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
    }) => {
      skipUnlessWebgl2();
      test.setTimeout(120_000);
      const errors = watchErrors(page);
      await page.setViewportSize(viewport);
      await openScene(page);
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
      expectNoErrors(errors);
    });
  }

  test('desktop coarse-pointer bar keeps 44px targets with every column visible', async ({ browser }) => {
    skipUnlessWebgl2();
    test.setTimeout(120_000);
    const context = await browser.newContext({
      baseURL: 'http://localhost:4173',
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = watchErrors(page);
    try {
      await openScene(page);
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
      expectNoErrors(errors);
    } finally {
      await context.close();
    }
  });

  test('desktop forced colours keep native controls at 24px with hit ownership', async ({ page }) => {
    skipUnlessWebgl2();
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ forcedColors: 'active' });
    await openScene(page);
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
    expectNoErrors(errors);
  });

  // Opening the bar moves focus to its first control. Keyboard opening shows that control's
  // tooltip; a mouse click must not, or the tooltip covers the KeyLight title every time.
  test('desktop bar shows the focus tooltip after keyboard opening only', async ({ page }) => {
    skipUnlessWebgl2();
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScene(page);
    // The tooltip module installs after the ready attribute; the mouse-open branch would pass without it.
    await waitForTooltipInstallation(page, SCENE_READY_TIMEOUT);
    const toggle = page.locator('#shell-light-toggle');
    const panel = page.locator('#shell-light-panel');
    const keySwitch = panel.locator('[data-light="key"] .lightpanel__switch');
    const tooltip = page.locator('#a11y-tooltip[role="tooltip"]');

    await toggle.click();
    await expect(panel).toBeVisible();
    await expect(keySwitch).toBeFocused();
    await page.waitForTimeout(300);
    await expect(tooltip, 'mouse opening shows no focus tooltip').toBeHidden();
    expect(await keySwitch.getAttribute('aria-describedby')).toBeNull();
    await toggle.click();
    await expect(panel).toBeHidden();

    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(panel).toBeVisible();
    await expect(keySwitch).toBeFocused();
    await expect(tooltip, 'keyboard opening shows the focus tooltip').toBeVisible();
    await expect(tooltip).toHaveText('Toggle KeyLight on or off');
    expect(await keySwitch.getAttribute('aria-describedby')).toBe('a11y-tooltip');
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    expectNoErrors(errors);
  });

  for (const viewport of VIEWPORTS.filter((entry) => entry.sheet)) {
    test(`sheet modal semantics preserve rail, Look, and proof hit ownership at ${viewport.width}x${viewport.height}`, async ({
      page,
    }) => {
      skipUnlessWebgl2();
      test.setTimeout(120_000);
      const errors = watchErrors(page);
      await page.setViewportSize(viewport);
      await openScene(page);
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
      expectNoErrors(errors);
    });
  }

  test('keyboard, pointer, native inputs, persistence, share state, and idle', async ({ page }) => {
    skipUnlessWebgl2();
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScene(page);
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
    expectNoErrors(errors);
  });

  test('warm and cool colors round-trip exactly for every studio light on each backend', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const backend = test.info().project.name;
    const scenePath =
      backend === 'webgl2'
        ? '/?webgl=1&gate=off&e2e=1&proof=1&music=off'
        : '/?gate=off&e2e=1&proof=1&music=off';
    let canvas = await openScene(page, scenePath);
    await expect(canvas).toHaveAttribute('data-backend', backend);

    const defaults = { key: '#ffffff', fill: '#ffffff', back: '#ffffff' };
    const colors = { ...defaults };
    const expectedRig = () =>
      `v2;key,1,15,${colors.key.slice(1)};fill,0,7,${colors.fill.slice(1)};back,0,7,${colors.back.slice(1)};day,0.5`;
    const panel = page.locator('#shell-light-panel');
    const toggle = page.locator('#shell-light-toggle');
    await toggle.click();
    await expect(panel).toBeVisible();
    await expectDefaultRigWithoutUrl(page, expectedRig());

    const assertPanelColors = async () => {
      for (const id of STUDIO_LIGHTS) {
        await expect(panel.locator(`[data-light="${id}"] .lightpanel__color`)).toHaveValue(colors[id]);
        await expect(panel.locator(`[data-light="${id}"] .lightpanel__value--color`)).toHaveText(
          colors[id],
        );
      }
    };
    const applyColor = async (id: (typeof STUDIO_LIGHTS)[number], color: string, label: string) => {
      const input = panel.locator(`[data-light="${id}"] .lightpanel__color`);
      const readout = panel.locator(`[data-light="${id}"] .lightpanel__value--color`);
      await setNativeInput(input, color);
      colors[id] = color;
      await expect(input, `${id} ${label} color input`).toHaveValue(color);
      await expect(readout, `${id} ${label} color readout`).toHaveText(color);
      await expectRigAndUrl(page, expectedRig());
    };

    for (const id of STUDIO_LIGHTS) await applyColor(id, '#ff9a3c', 'warm');
    const warmRig = expectedRig();
    canvas = await openScene(page, `${scenePath}&rig=${encodeURIComponent(warmRig)}`);
    await expect(canvas).toHaveAttribute('data-backend', backend);
    await expectRigAndUrl(page, warmRig);
    await page.locator('#shell-light-toggle').click();
    await expect(panel).toBeVisible();
    await assertPanelColors();

    for (const id of STUDIO_LIGHTS) await applyColor(id, '#3c9aff', 'cool');
    const coolRig = expectedRig();
    canvas = await openScene(page, `${scenePath}&rig=${encodeURIComponent(coolRig)}`);
    await expect(canvas).toHaveAttribute('data-backend', backend);
    await expectRigAndUrl(page, coolRig);
    await page.locator('#shell-light-toggle').click();
    await expect(panel).toBeVisible();
    await assertPanelColors();
    await expectRigAndUrl(page, expectedRig());
    await waitForLoopIdle(page);
    expectNoErrors(errors);
  });

  test('daylight drag serializes coordinated exposure exactly on each backend', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const backend = test.info().project.name;
    const canvas = await openScene(
      page,
      backend === 'webgl2'
        ? '/?webgl=1&gate=off&e2e=1&proof=1&music=off'
        : '/?gate=off&e2e=1&proof=1&music=off',
    );
    await expect(canvas).toHaveAttribute('data-backend', backend);

    const panel = page.locator('#shell-light-panel');
    await page.locator('#shell-light-toggle').click();
    await expect(panel).toBeVisible();
    const daylight = panel.locator('.lightpanel__range--daylight');
    const readout = panel.locator('[data-light="daylight"] .lightpanel__value--daylight');

    await setNativeInput(daylight, '0.2');
    await expect(daylight).toHaveValue('0.2');
    await expect(readout).toHaveText('Dawn');
    await expectRigAndUrl(
      page,
      'v2;key,1,15,ffffff;fill,0,7,ffffff;back,0,7,ffffff;day,0.2;e,1.06',
    );

    await setNativeInput(daylight, '0.85');
    await expect(daylight).toHaveValue('0.85');
    await expect(readout).toHaveText('Noon');
    await expectRigAndUrl(
      page,
      'v2;key,1,15,ffffff;fill,0,7,ffffff;back,0,7,ffffff;day,0.85;e,0.93',
    );
    await waitForLoopIdle(page);
    expectNoErrors(errors);
  });

  test('three-point states and intensity endpoints retain one draw-call census on each backend', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const backend = test.info().project.name;
    const scenePath =
      backend === 'webgl2'
        ? '/?webgl=1&gate=off&e2e=1&proof=1&music=off'
        : '/?gate=off&e2e=1&proof=1&music=off';
    const canvas = await openScene(page, scenePath);
    await expect(canvas).toHaveAttribute('data-backend', backend);

    const enabled = { key: true, fill: false, back: false };
    const intensities = { key: 15, fill: 7, back: 7 };
    const expectedRig = () =>
      `v2;key,${enabled.key ? 1 : 0},${intensities.key},ffffff;fill,${enabled.fill ? 1 : 0},${intensities.fill},ffffff;back,${enabled.back ? 1 : 0},${intensities.back},ffffff;day,0.5`;

    await expectDefaultRigWithoutUrl(page, expectedRig());
    await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);
    // The panel may still show an empty warm-up frame. Compare two actual refreshes after
    // initialization, including scale/post, rather than polling the same stale text twice.
    let previous = await nextProofReading(page);
    let baselineDrawCalls: number | null = null;
    await expect.poll(async () => {
      const current = await nextProofReading(page);
      baselineDrawCalls = stableDrawCalls(previous, current);
      previous = current;
      return baselineDrawCalls;
    }, { timeout: 30_000 }).not.toBeNull();
    if (baselineDrawCalls === null) throw new Error('missing Key-only draw-call baseline');

    const panel = page.locator('#shell-light-panel');
    await page.locator('#shell-light-toggle').click();
    await expect(panel).toBeVisible();
    const toggle = (id: (typeof STUDIO_LIGHTS)[number]) =>
      panel.locator(`[data-light="${id}"] .lightpanel__switch`);

    await toggle('fill').click();
    enabled.fill = true;
    await expectRigAndUrl(page, expectedRig());

    await toggle('fill').click();
    enabled.fill = false;
    await toggle('back').click();
    enabled.back = true;
    await expectRigAndUrl(page, expectedRig());

    await toggle('fill').click();
    enabled.fill = true;
    await expectRigAndUrl(page, expectedRig());
    await expect.poll(() => proofDrawCalls(page), { timeout: 30_000 }).toBe(baselineDrawCalls);

    for (const id of STUDIO_LIGHTS) {
      const range = panel.locator(`[data-light="${id}"] .lightpanel__range`);
      const readout = panel.locator(`[data-light="${id}"] .lightpanel__value--intensity`);
      await setNativeInput(range, '0');
      intensities[id] = 0;
      await expect(range, `${id} minimum intensity input`).toHaveValue('0');
      await expect(readout, `${id} minimum intensity readout`).toHaveText('0.0 cd');
      await expectRigAndUrl(page, expectedRig());
      await expect(canvas).toHaveAttribute('data-scene', 'ready');
      await expect.poll(() => proofDrawCalls(page), { timeout: 30_000 }).toBeGreaterThan(0);

      await setNativeInput(range, '50');
      intensities[id] = 50;
      await expect(range, `${id} maximum intensity input`).toHaveValue('50');
      await expect(readout, `${id} maximum intensity readout`).toHaveText('50.0 cd');
      await expectRigAndUrl(page, expectedRig());
      await expect(canvas).toHaveAttribute('data-scene', 'ready');
      await expect.poll(() => proofDrawCalls(page), { timeout: 30_000 }).toBeGreaterThan(0);
    }

    for (const id of STUDIO_LIGHTS) {
      await setNativeInput(panel.locator(`[data-light="${id}"] .lightpanel__range`), String(id === 'key' ? 15 : 7));
      intensities[id] = id === 'key' ? 15 : 7;
    }
    await toggle('fill').click();
    enabled.fill = false;
    await toggle('back').click();
    enabled.back = false;
    await expectDefaultRigWithoutUrl(page, expectedRig());
    await waitForLoopIdle(page);
    expectNoErrors(errors);
  });

  test('closed drawer preserves card, rail, Measure, music, and responsive focus continuity', async ({
    page,
  }) => {
    skipUnlessWebgl2();
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScene(page);
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
    expectNoErrors(errors);
  });

  test('touchscreen tap opens and closes the phone drawer', async ({ browser }) => {
    skipUnlessWebgl2();
    const touch = await newTouchPage(browser);
    const errors = watchErrors(touch.page);
    try {
      await openScene(touch.page);
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
      expectNoErrors(errors);
    } finally {
      await touch.context.close();
    }
  });

  test('phone reduced motion removes sheet movement from the rendered drawer', async ({ page }) => {
    skipUnlessWebgl2();
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openScene(page);
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
          root.getPropertyValue('--dur-slow').trim(),
        ],
        row: { transition: rowStyle.transitionDuration, animation: rowStyle.animationDuration },
        panel: { transition: panelStyle.transitionDuration, animation: panelStyle.animationDuration },
      };
    });
    // Browsers canonicalize a zero CSS custom-property duration inconsistently (the authored
    // reduced-motion override is `0ms`, while Chromium serializes it here as `0s`). Either
    // spelling proves the value is zero; a non-zero value would animate the phone sheet.
    expect(motion.tokens).toEqual(['0s', '0s', '0s']);
    for (const duration of [
      motion.row.transition,
      motion.row.animation,
      motion.panel.transition,
      motion.panel.animation,
    ]) {
      expect(['0s', '0ms', '0s, 0s']).toContain(duration);
    }
  });

  test('WebGPU smoke opens the drawer and updates serialized rig when available', async ({ page }) => {
    test.skip(test.info().project.name !== 'webgpu', 'WebGPU smoke belongs to the WebGPU project');
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const canvas = await openScene(page, '/?gate=off&e2e=1&proof=1&music=off');
    await expect(canvas).toHaveAttribute('data-backend', 'webgpu');
    await page.locator('#shell-light-toggle').click();
    const key = page.locator('[data-light="key"] .lightpanel__switch');
    // `data-scene=ready` is published by the first drawn content frame. On the actual WebGPU
    // path, shader compilation and final test-handle mounting can still follow it, so wait for
    // the handle rather than treating that transient null as the pre-toggle rig state.
    await expect
      .poll(() => page.evaluate(() => window.archvizE2E?.rigState() ?? null), { timeout: 30_000 })
      .toMatch(/^v2;/);
    const before = await page.evaluate(() => window.archvizE2E?.rigState() ?? null);
    await key.click();
    await expect.poll(() => page.evaluate(() => window.archvizE2E?.rigState() ?? null)).not.toBe(before);
    expectNoErrors(errors);
  });
});
