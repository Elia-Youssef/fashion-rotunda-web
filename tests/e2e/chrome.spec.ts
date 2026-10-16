import { expect, expectConsoleError, test } from './support/fixtures';
import type { Page } from '@playwright/test';
import { openShowroom, readCatalog } from './support/showroom';

// The visitor-facing chrome. The strip switches the look, the card names it, the
// swatches swap the mannequin and Reset returns the default. The checks are about the DOM, not the
// backend, so both projects run them; each page is pinned to its project's backend through the
// canvas data-backend attribute before any DOM reading.

/** One look fetch through the local preview server, well past the five-second assertion default. */
const SWITCH_TIMEOUT = 30_000;

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`failed look switch keeps the previous look and reports once at ${viewport.width}x${viewport.height}`, async ({
    page, request,
  }) => {
    await page.setViewportSize(viewport);
    const { canvas, catalog } = await openShowroom(page, request, '/?e2e=1&music=off');
    const previous = catalog.looks[0];
    const target = catalog.looks[1];
    const routePattern = `**/content/${target.file}`;
    await page.route(routePattern, (route) => route.abort());
    expectConsoleError(page, /^Failed to load resource: net::ERR_FAILED/,
      'the later look GLB is deliberately aborted to exercise switch recovery');
    const live = page.locator('.a11y-live-region');
    await expect(live).toHaveCount(1);
    await expect(live).toHaveAttribute('aria-live', 'polite');
    const liveRegionCount = await page.locator('[aria-live]').count();
    const targetButton = page.locator(`#looks button[data-look="${target.id}"]`);
    await targetButton.click();

    const message = 'That look could not load. Select it again to try once more.';
    const notice = page.locator('[data-look-status]');
    await expect(notice).toHaveCount(1);
    await expect(notice).toHaveText(message);
    await expect(notice).toBeVisible();
    await expect(live).toHaveText(message);
    await expect(page.locator('[aria-live]')).toHaveCount(liveRegionCount);
    await expect(canvas).toHaveAttribute('data-look', previous.id);
    await expect(page.locator('.product-card h2')).toHaveText(previous.name);
    await expect(page.locator(`#looks button[data-look="${previous.id}"]`)).toHaveAttribute('aria-current', 'true');
    await expect(targetButton).not.toHaveAttribute('aria-busy');
    await expect(targetButton).not.toHaveAttribute('aria-current');

    await page.unroute(routePattern);
    await targetButton.click();
    await expect(canvas).toHaveAttribute('data-look', target.id, { timeout: SWITCH_TIMEOUT });
    await expect(notice).toBeHidden();
    await expect(notice).toHaveText('');
    await expect(targetButton).toHaveAttribute('aria-current', 'true');
  });
}

test('the strip switches the look and the card names it', async ({ page, request }) => {
  const { canvas, catalog } = await openShowroom(page, request, '/?gate=off');
  const third = catalog.looks[2];

  const thumbnails = page.locator('#looks button');
  await thumbnails.nth(2).click();

  await expect(canvas).toHaveAttribute('data-look', third.id, { timeout: SWITCH_TIMEOUT });
  await expect(page.locator('.product-card h2')).toHaveText(third.name);
  await expect(thumbnails.nth(2)).toHaveAttribute('aria-current', 'true');
});

test('the swatches switch the mannequin and Reset returns the default', async ({
  page,
  request,
}) => {
  const catalog = await readCatalog(request);
  const first = catalog.looks[0];
  expect(first.variants, 'the first look carries a dark variant').toContain('dark');

  const { canvas } = await openShowroom(page, request, '/?gate=off');

  await page.getByRole('radio', { name: 'Dark charcoal' }).click();
  await expect(canvas).toHaveAttribute('data-variant', 'dark', { timeout: SWITCH_TIMEOUT });
  await expect(page.getByRole('radio', { name: 'Dark charcoal' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  await page.getByRole('button', { name: 'Reset' }).click();
  await expect(canvas).toHaveAttribute('data-variant', first.defaultVariant, {
    timeout: SWITCH_TIMEOUT,
  });
  await expect(page.getByRole('radio', { name: 'Default' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
});

// The reachability census: at each of the three shell viewports, with the sheets opened
// where they exist, every census control is visible, sized for a touch (44 by 44 CSS px on the
// phone viewport), inside the viewport, and no two census boxes intersect. The Light Control
// drawer starts closed on every breakpoint, so its phase is asserted after opening it through the
// same toggle a visitor uses. The phone keeps one sheet at a time, so its census runs in three
// phases: closed first, then the Look sheet, then the Light sheet; every control is asserted in
// at least one phase. The page itself never scrolls at any point.

interface CensusControl {
  name: string;
  selector: string;
  /** Which sheet phase the control belongs to: 'card', 'light', or both (always visible). */
  phase: 'card' | 'light' | 'both';
}

function census(): CensusControl[] {
  const entries: Array<[string, string, CensusControl['phase']]> = [
    ['first thumbnail', '#looks button >> nth=0', 'both'],
    ['Rotate', '.product-card__action[data-action="rotate"]', 'card'],
    ['Reset', '.product-card__action[data-action="reset"]', 'card'],
    ['Material', '.product-card__action[data-action="material"]', 'card'],
    ['swatch 1', '.product-card__swatch >> nth=0', 'card'],
    ['swatch 2', '.product-card__swatch >> nth=1', 'card'],
    ['swatch 3', '.product-card__swatch >> nth=2', 'card'],
    ['Copy link', '.share__button--copy', 'card'],
    ['Screenshot', '.share__button--screenshot', 'card'],
    ['music switch', 'header button.music-switch', 'both'],
    ['Orbit mode', 'button[data-mode="orbit"]', 'both'],
    ['Walk mode', 'button[data-mode="walk"]', 'both'],
    ['Light Control', '#shell-light-toggle', 'light'],
    ['first light on switch', '.lightpanel__row[data-light="key"] .lightpanel__switch', 'light'],
    ['first light color', '.lightpanel__row[data-light="key"] .lightpanel__color', 'light'],
    ['Measure', '.proof-panel__measure', 'both'],
    ['badge', '.badge', 'both'],
  ];
  return entries.map(([name, selector, phase]) => ({ name, selector, phase }));
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A non-zero synthetic cut-out proves the token abstraction rather than Chromium's zero env(). */
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

function boxesIntersect(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

async function readBox(page: Page, control: CensusControl): Promise<Box | null> {
  const locator = page.locator(control.selector);
  if (!(await locator.isVisible())) {
    return null;
  }
  const box = await locator.boundingBox();
  return box;
}

/** Asserts one phase: every phase control visible, sized, on screen, pairwise disjoint. */
async function assertPhase(
  page: Page,
  controls: CensusControl[],
  phone: boolean,
  label: string,
): Promise<void> {
  const viewport = page.viewportSize();
  const boxes: Array<{ name: string; box: Box }> = [];
  for (const control of controls) {
    const box = await readBox(page, control);
    if (box === null) {
      throw new Error(`${label}: ${control.name} is not visible`);
    }
    boxes.push({ name: control.name, box });
    if (phone) {
      expect(box.height, `${label}: ${control.name} is at least 44 px tall`).toBeGreaterThanOrEqual(
        44,
      );
      expect(box.width, `${label}: ${control.name} is at least 44 px wide`).toBeGreaterThanOrEqual(
        44,
      );
    }
    if (viewport !== null) {
      const onScreen =
        box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width &&
        box.y + box.height <= viewport.height;
      expect(onScreen, `${label}: ${control.name} is fully inside the viewport`).toBe(true);
    }
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const left = boxes[i];
      const right = boxes[j];
      expect(
        boxesIntersect(left.box, right.box),
        `${label}: ${left.name} and ${right.name} do not overlap`,
      ).toBe(false);
    }
  }
  const scroll = await page.evaluate(() => {
    const scroller = document.scrollingElement;
    return (
      scroller !== null &&
      scroller.scrollHeight <= scroller.clientHeight &&
      scroller.scrollWidth <= scroller.clientWidth
    );
  });
  expect(scroll, `${label}: the page never scrolls`).toBe(true);
}

/** A control can scroll inside a short sheet, but must still become visible and touch-sized. */
async function assertReachableInSheet(
  page: Page,
  control: CensusControl,
  label: string,
): Promise<void> {
  const locator = page.locator(control.selector);
  await locator.scrollIntoViewIfNeeded();
  expect(await locator.isVisible(), `${label}: ${control.name} is visible after sheet scroll`).toBe(true);
  const box = await locator.boundingBox();
  expect(box, `${label}: ${control.name} has a bounding box`).not.toBeNull();
  if (box === null) {
    return;
  }
  expect(box.width, `${label}: ${control.name} is at least 44 px wide`).toBeGreaterThanOrEqual(44);
  expect(box.height, `${label}: ${control.name} is at least 44 px tall`).toBeGreaterThanOrEqual(44);
  const viewport = page.viewportSize();
  if (viewport !== null) {
    expect(box.x < viewport.width && box.y < viewport.height, `${label}: ${control.name} is on screen`).toBe(
      true,
    );
    expect(box.x + box.width > 0 && box.y + box.height > 0, `${label}: ${control.name} is on screen`).toBe(
      true,
    );
  }
}

async function assertShortLandscape(page: Page, controls: CensusControl[], tag: string): Promise<void> {
  const canvas = page.locator('canvas#scene');
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox, `${tag}: canvas has a box`).not.toBeNull();
  expect(canvasBox?.width, `${tag}: canvas has positive width`).toBeGreaterThan(0);
  expect(canvasBox?.height, `${tag}: canvas has positive height`).toBeGreaterThan(0);

  // The badge corner floats over the scene rather than claiming a footer row, so the sheets are
  // bounded by the viewport itself, not by a strip below the stage.
  const viewport = page.viewportSize();
  const insideViewport = (label: string, box: { x: number; y: number; width: number; height: number } | null): void => {
    expect(box, `${tag}: ${label} has a bounding box`).not.toBeNull();
    if (box === null || viewport === null) {
      return;
    }
    expect(box.width, `${tag}: ${label} has positive width`).toBeGreaterThan(0);
    expect(box.height, `${tag}: ${label} has positive height`).toBeGreaterThan(0);
    expect(
      box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height,
      `${tag}: ${label} stays inside the viewport`,
    ).toBe(true);
  };

  const safeAreaOffsets = await page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) {
        return null;
      }
      const style = getComputedStyle(element);
      return { left: style.left, right: style.right };
    };
    return {
      looks: read('#looks'),
      lookPill: read('.shell-pill--look'),
      lightRow: read('#shell-light-row'),
    };
  });
  // Chromium's desktop viewport has zero physical insets, so these are the token-only resolved
  // values. The CSS rule itself adds the platform env() inset, keeping landscape cut-outs clear.
  expect(safeAreaOffsets.looks, `${tag}: rail has left and right safe-area offsets`).toEqual({
    left: '8px',
    right: '8px',
  });
  expect(safeAreaOffsets.lookPill, `${tag}: Look pill has a left safe-area offset`).toMatchObject({
    left: '12px',
  });
  expect(safeAreaOffsets.lightRow, `${tag}: Light Control has a right safe-area offset`).toMatchObject({
    right: '12px',
  });

  await page.locator('.shell-pill--look').click();
  const card = page.locator('#shell-card');
  const cardBox = await card.boundingBox();
  insideViewport('card sheet', cardBox);

  const footerControls = controls.filter(
    (entry) => entry.selector === '.proof-panel__measure' || entry.selector === '.badge',
  );
  const footerBox = await page.locator('footer').boundingBox();
  expect(footerBox, `${tag}: footer has a bounding box`).not.toBeNull();
  if (cardBox !== null && footerBox !== null) {
    expect(
      cardBox.y + cardBox.height,
      `${tag}: card sheet clears the persistent footer controls`,
    ).toBeLessThanOrEqual(footerBox.y + 1);
  }
  // Short sheets are intentionally internally scrollable: each control must be reachable, but
  // they do not all need to fit in the 390 px viewport simultaneously.
  for (const control of controls.filter((entry) => entry.phase === 'card')) {
    await assertReachableInSheet(page, control, `${tag} card sheet`);
  }
  await assertPhase(page, footerControls, true, `${tag} card sheet footer`);

  await page.locator('#shell-card .shell-sheet__close').click();
  await page.locator('#shell-light-toggle').click();
  const lightBox = await page.locator('#shell-light-row').boundingBox();
  insideViewport('light sheet', lightBox);
  if (lightBox !== null && footerBox !== null) {
    expect(
      lightBox.y + lightBox.height,
      `${tag}: light sheet clears the persistent footer controls`,
    ).toBeLessThanOrEqual(footerBox.y + 1);
  }
  for (const control of controls.filter((entry) => entry.phase === 'light')) {
    await assertReachableInSheet(page, control, `${tag} light sheet`);
  }
  await assertPhase(page, footerControls, true, `${tag} light sheet footer`);

  const scroll = await page.evaluate(() => {
    const scroller = document.scrollingElement;
    return (
      scroller !== null &&
      scroller.scrollHeight <= scroller.clientHeight &&
      scroller.scrollWidth <= scroller.clientWidth
    );
  });
  expect(scroll, `${tag}: the page never scrolls`).toBe(true);
}

const CENSUS_VIEWPORTS: Array<{
  width: number;
  height: number;
  phone: boolean;
  shortLandscape?: boolean;
}> = [
  { width: 390, height: 844, phone: true },
  { width: 844, height: 390, phone: true, shortLandscape: true },
  { width: 820, height: 1180, phone: false },
  { width: 1440, height: 900, phone: false },
];

for (const viewport of CENSUS_VIEWPORTS) {
  test(`every census control is reachable at ${viewport.width}x${viewport.height}`, async ({
    page,
    request,
  }) => {
    // The proof panel is part of the census, so the URL asks for it. The shared opening pins the
    // backend and waits for the mounted strip, card and mode buttons; the light panel is census
    // chrome beyond that opening, so the census waits for it here before its phases read boxes.
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openShowroom(page, request, '/?e2e=1&proof=1');
    await expect(page.locator('.lightpanel')).toHaveCount(1);

    const controls = census();
    const tag = `${viewport.width}x${viewport.height}`;
    // The closed phase: the always-visible chrome, plus the Light Control launcher itself.
    const closedPhase = [
      ...controls.filter((control) => control.phase === 'both'),
      { name: 'Light Control', selector: '#shell-light-toggle', phase: 'light' } as CensusControl,
    ];
    if (viewport.shortLandscape === true) {
      await assertPhase(page, closedPhase, true, `${tag} closed`);
      await assertShortLandscape(page, controls, tag);
      return;
    }
    if (!viewport.phone) {
      // Closed chrome first; then the drawer opens through the toggle and the whole census holds
      // with the card as the floating overlay of the upper right.
      await assertPhase(page, closedPhase, false, `${tag} closed`);
      await page.locator('#shell-light-toggle').click();
      await expect(page.locator('#shell-light-panel')).toBeVisible();
      await assertPhase(page, controls, false, tag);
      return;
    }

    // Phase 0: closed. Phase 1 retains the footer's Badge and Measure action below the Look sheet.
    // Phase 2 does the same below the Light sheet, so no sheet merely paints over a live control.
    await assertPhase(page, closedPhase, true, `${tag} closed`);
    await page.locator('.shell-pill--look').click();
    const cardPhase = [
      ...controls.filter((control) => control.phase === 'card'),
      ...controls.filter(
        (control) => control.selector === '.proof-panel__measure' || control.selector === '.badge',
      ),
    ];
    await assertPhase(page, cardPhase, true, `${tag} look sheet`);

    await page.locator('#shell-card .shell-sheet__close').click();
    await page.locator('#shell-light-toggle').click();
    const lightPhase = [
      ...controls.filter((control) => control.phase === 'light'),
      ...controls.filter(
        (control) => control.selector === '.proof-panel__measure' || control.selector === '.badge',
      ),
    ];
    await assertPhase(page, lightPhase, true, `${tag} light sheet`);
  });
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
