import { expect, test } from './support/fixtures';
import type { Page } from '@playwright/test';
import { openShowroom } from './support/showroom';
import { boxesIntersect, type Box } from './support/geometry';

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
