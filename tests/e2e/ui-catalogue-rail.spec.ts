import { expect, test } from './support/fixtures';
import { waitForLoopIdle, waitForSceneInitialization } from './support/ready';
import type { Locator, Page } from '@playwright/test';
import { holdFirstRequest } from './support/held-request';

// Catalogue rail E2E verification.
// Covers four benchmark viewports, internal horizontal scrolling below the desktop width,
// synthetic safe-area insets, actionable point elementFromPoint hit testing,
// pointer and keyboard (Enter, Space) selection, breakpoint focus continuity,
// latest-click-wins race resolution, and deterministic pending/busy state.
//
// The desktop rail adapts to the available width and height: from 1200px wide the rail shows all
// seven looks at once with no internal scroll, keeps
// its bottom 140px above the viewport bottom for the light bar, shrinks the thumbnails on a short
// window down to the 24px floor, and scrolls only below that floor.

const SCENE_READY_TIMEOUT = 60_000;
const SWITCH_TIMEOUT = 30_000;

function skipUnlessWebgl2(): void {
  test.skip(test.info().project.name !== 'webgl2', 'the chrome checks are backend independent');
}

// attract=0 keeps the idle tour from starting after 60 s and rendering every frame, and post=off
// drops the post chain; both only slow the software renderer, and these checks are DOM layout.
async function openScene(
  page: Page,
  path = '/?webgl=1&gate=off&e2e=1&proof=1&attract=0&post=off',
): Promise<Locator> {
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

const LIGHT_BAR_RESERVE = 140;
const RESIZE_TIMEOUT = 10_000;

/** Waits for both the viewport and the closed card's responsive sheet state before layout reads. */
async function resizeTo(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.waitForFunction(
    ([w, h]) => {
      if (window.innerWidth !== w || window.innerHeight !== h) return false;
      // CSS can change before the shell's media-query change callback applies hidden.
      const card = document.querySelector<HTMLElement>('#shell-card');
      const sheetMode =
        !matchMedia('(min-width: 768px)').matches ||
        matchMedia('(max-height: 599px)').matches;
      return card !== null && card.hidden === sheetMode;
    },
    [width, height],
    { timeout: RESIZE_TIMEOUT },
  );
}

interface DesktopRailReading {
  top: number;
  bottom: number;
  scrollHeight: number;
  clientHeight: number;
  sizes: { width: number; height: number }[];
  owned: boolean[];
  owners: { look: string | null; hit: string | null; region: string | null }[];
  currentCount: number;
  documentScrolls: boolean;
}

async function readDesktopRail(page: Page): Promise<DesktopRailReading> {
  return page.locator('#looks').evaluate((el) => {
    const hits = (button: Element) => {
      const r = button.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      const describe = (element: Element | null): string | null =>
        element === null
          ? null
          : `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${
              [...element.classList].map((name) => `.${name}`).join('')
            }`;
      return {
        owned: hit !== null && (hit === button || button.contains(hit)),
        owner: {
          look: button.getAttribute('data-look'),
          hit: describe(hit),
          region: describe(hit?.closest('[id]') ?? null),
        },
      };
    };
    const buttons = [...el.querySelectorAll('button')];
    const centres = buttons.map(hits);
    const scroller = document.scrollingElement;
    const box = el.getBoundingClientRect();
    return {
      top: box.top,
      bottom: box.bottom,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      sizes: buttons.map((b) => {
        const r = b.getBoundingClientRect();
        return { width: r.width, height: r.height };
      }),
      owned: centres.map((centre) => centre.owned),
      owners: centres.map((centre) => centre.owner),
      currentCount: el.querySelectorAll('button[aria-current="true"]').length,
      documentScrolls:
        scroller !== null &&
        (scroller.scrollHeight > scroller.clientHeight || scroller.scrollWidth > scroller.clientWidth),
    };
  });
}

/**
 * Focuses a thumbnail as the keyboard would (focusVisible, and the focus does its own scrolling)
 * and reports whether its outline, width plus offset, stays inside the rail's padding box.
 */
async function focusRing(
  page: Page,
  index: number,
): Promise<{ focusVisible: boolean; outlineStyle: string; inside: boolean }> {
  return page
    .locator('#looks button')
    .nth(index)
    .evaluate((button) => {
      button.focus({ focusVisible: true });
      const rail = button.closest('#looks');
      if (rail === null) throw new Error('rail missing');
      const style = getComputedStyle(button);
      const reach = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
      const r = button.getBoundingClientRect();
      const rr = rail.getBoundingClientRect();
      return {
        focusVisible: button.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        inside:
          r.left - reach >= rr.left + rail.clientLeft - 0.01 &&
          r.top - reach >= rr.top + rail.clientTop - 0.01 &&
          r.right + reach <= rr.left + rail.clientLeft + rail.clientWidth + 0.01 &&
          r.bottom + reach <= rr.top + rail.clientTop + rail.clientHeight + 0.01,
      };
    });
}

test.describe('Catalogue Rail Parity', () => {
  const GEOMETRY_VIEWPORTS = [
    { id: 'desktop', width: 1440, height: 900, axis: 'y' },
    { id: 'tablet', width: 820, height: 1180, axis: 'x' },
    { id: 'phone', width: 390, height: 844, axis: 'x', checkTouch: true },
    { id: 'shortLandscape', width: 844, height: 390, axis: 'x', checkTouch: true },
  ];

  // One cold scene load per test, so each viewport stays inside the default test timeout.
  for (const vp of GEOMETRY_VIEWPORTS) {
    test(`rail geometry, internal scrolling, touch sizing, and zero document scroll at ${vp.id}`, async ({
      page,
    }) => {
      skipUnlessWebgl2();

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openScene(page);

      const rail = page.locator('#looks');
      await expect(rail).toBeVisible();

      // Ensure all 7 shipped looks are present in catalogue source order
      const buttons = rail.locator('button');
      await expect(buttons).toHaveCount(7);
      const expectedIds = [
        'wallis-dress',
        'zoot-suit',
        'new-look-dress',
        'mondrian-dress',
        'jumpsuit-dress',
        'blue-silk-dress',
        'geoffrey-beene',
      ];
      for (let i = 0; i < expectedIds.length; i++) {
        await expect(buttons.nth(i)).toHaveAttribute('data-look', expectedIds[i]);
      }

      // Check document scrolling: must NEVER scroll
      const docScroll = await page.evaluate(() => {
        const scroller = document.scrollingElement;
        return {
          hasDocScroll:
            scroller !== null &&
            (scroller.scrollHeight > scroller.clientHeight ||
              scroller.scrollWidth > scroller.clientWidth ||
              window.scrollX !== 0 ||
              window.scrollY !== 0),
          scrollHeight: scroller?.scrollHeight,
          clientHeight: scroller?.clientHeight,
          scrollWidth: scroller?.scrollWidth,
          clientWidth: scroller?.clientWidth,
        };
      });
      expect(docScroll.hasDocScroll, `${vp.id}: document must not scroll`).toBe(false);

      // Check internal scrolling for the required axis
      const railMetrics = await rail.evaluate((el) => ({
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowX: getComputedStyle(el).overflowX,
        overflowY: getComputedStyle(el).overflowY,
      }));

      if (vp.axis === 'y') {
        // Desktop: every look fits, so the rail has nothing to scroll (client review item 1).
        // overflow-y stays auto as the last resort below the thumbnail floor.
        expect(
          railMetrics.scrollHeight,
          `${vp.id}: rail shows all seven looks without internal scrolling`,
        ).toBeLessThanOrEqual(railMetrics.clientHeight);
        expect(railMetrics.overflowY).toBe('auto');
      } else {
        // Tablet and Phone: prove horizontal internal scrolling
        if (vp.id === 'tablet' || vp.id === 'phone') {
          expect(
            railMetrics.scrollWidth,
            `${vp.id}: rail scrollWidth must exceed clientWidth for horizontal internal scrolling`,
          ).toBeGreaterThan(railMetrics.clientWidth);

          await rail.evaluate((el) => {
            el.scrollLeft = 40;
          });
          const scrollLeft = await rail.evaluate((el) => el.scrollLeft);
          expect(scrollLeft, `${vp.id}: rail scrollLeft must be scrollable`).toBeGreaterThan(0);
        }
        expect(railMetrics.overflowX).toBe('auto');
      }

      // Check touch sizing on phone viewports (>=44x44 CSS px)
      if (vp.checkTouch) {
        for (let i = 0; i < 7; i++) {
          const box = await buttons.nth(i).boundingBox();
          expect(box, `${vp.id}: button ${i} has bounding box`).not.toBeNull();
          if (box) {
            expect(box.width, `${vp.id}: button ${i} width >= 44px`).toBeGreaterThanOrEqual(44);
            expect(box.height, `${vp.id}: button ${i} height >= 44px`).toBeGreaterThanOrEqual(44);
          }
        }
      }
    });
  }

  // Client review item 1 at the client's own window: 1669x1115 at a 1.25 device scale. The walk
  // then resizes one page through the other desktop sizes. The layout depends only on the height
  // once the width is 1200 or more. fit: 48px thumbnails, no scroll; shrink: smaller thumbnails,
  // still no scroll, at least the 24px WCAG 2.5.8 floor; floor: 24px and the rail scrolls.
  test.describe('desktop rail at the client scale', () => {
    test.use({ viewport: { width: 1669, height: 1115 }, deviceScaleFactor: 1.25 });

    test('desktop rail shows all seven looks at once, clear of the light bar, down to short windows', async ({
      page,
    }) => {
      skipUnlessWebgl2();

      const viewports = [
        { id: '1669x1115', width: 1669, height: 1115, mode: 'fit' },
        { id: '1920x1080', width: 1920, height: 1080, mode: 'fit' },
        { id: '1440x900', width: 1440, height: 900, mode: 'fit' },
        { id: '1280x720', width: 1280, height: 720, mode: 'fit' },
        { id: '1200x640', width: 1200, height: 640, mode: 'fit' },
        { id: '1280x560', width: 1280, height: 560, mode: 'shrink' },
        { id: '1440x500', width: 1440, height: 500, mode: 'shrink' },
        { id: '1280x420', width: 1280, height: 420, mode: 'floor' },
      ] as const;

      await openScene(page);

      for (const vp of viewports) {
        await resizeTo(page, vp.width, vp.height);
        const tag = `desktop ${vp.id} @1.25`;
        const reading = await readDesktopRail(page);

        expect(reading.documentScrolls, `${tag}: document must not scroll`).toBe(false);
        expect(reading.top, `${tag}: rail keeps its top under the header`).toBeCloseTo(72, 0);
        expect(reading.currentCount, `${tag}: exactly one look is marked current`).toBe(1);
        expect(reading.sizes, `${tag}: seven thumbnails`).toHaveLength(7);
        expect(
          reading.bottom,
          `${tag}: rail ends at least ${LIGHT_BAR_RESERVE}px above the viewport bottom`,
        ).toBeLessThanOrEqual(vp.height - LIGHT_BAR_RESERVE + 0.5);
        for (const [i, size] of reading.sizes.entries()) {
          expect(size.width, `${tag}: thumbnail ${i} is at least 24px wide`).toBeGreaterThanOrEqual(24);
          expect(size.height, `${tag}: thumbnail ${i} is at least 24px tall`).toBeGreaterThanOrEqual(24);
          expect(size.width, `${tag}: thumbnail ${i} is square`).toBeCloseTo(size.height, 1);
          expect(size.width, `${tag}: thumbnail ${i} never grows past 48px`).toBeLessThanOrEqual(48);
        }

        if (vp.mode === 'floor') {
          // Last resort: the floor holds and the rail scrolls rather than shrinking further.
          expect(reading.sizes[0].width, `${tag}: thumbnails sit on the 24px floor`).toBeCloseTo(24, 1);
          expect(reading.scrollHeight, `${tag}: rail scrolls below the floor`).toBeGreaterThan(
            reading.clientHeight,
          );
          // Focus scrolls the rail; scroll padding keeps both ends' rings inside its clip.
          for (const index of [6, 0]) {
            const ring = await focusRing(page, index);
            expect(ring.focusVisible, `${tag}: thumbnail ${index} is focus-visible`).toBe(true);
            expect(ring.outlineStyle, `${tag}: thumbnail ${index} draws its outline`).toBe('solid');
            expect(ring.inside, `${tag}: thumbnail ${index} ring is not clipped`).toBe(true);
          }
          continue;
        }

        expect(
          reading.scrollHeight,
          `${tag}: rail shows all seven looks without internal scrolling`,
        ).toBeLessThanOrEqual(reading.clientHeight);
        expect(
          reading.owned,
          `${tag}: elementFromPoint owns every thumbnail centre; owners=${JSON.stringify(reading.owners)}`,
        ).toEqual(
          Array.from({ length: 7 }, () => true),
        );
        if (vp.mode === 'fit') {
          expect(reading.sizes[0].width, `${tag}: thumbnails keep 48px`).toBeCloseTo(48, 1);
        } else {
          expect(reading.sizes[0].width, `${tag}: thumbnails shrink to fit`).toBeLessThan(48);
        }
      }

      // Back at the client size, the last look's focus ring stays inside the rail.
      await resizeTo(page, 1669, 1115);
      const ring = await focusRing(page, 6);
      expect(ring.focusVisible, 'the last thumbnail is focus-visible').toBe(true);
      expect(ring.outlineStyle, 'focused thumbnail draws its outline').toBe('solid');
      expect(ring.inside, 'focus ring is not clipped by the rail').toBe(true);
    });
  });

  // A coarse pointer keeps the 44px touch target as the floor, so a short desktop window scrolls
  // the rail instead of shrinking the thumbnails below it.
  test.describe('desktop rail with a coarse pointer', () => {
    test.use({ viewport: { width: 1280, height: 560 }, hasTouch: true });

    test('keeps 44px thumbnails and scrolls, clear of the light bar, at 1280x560', async ({ page }) => {
      skipUnlessWebgl2();
      await openScene(page);
      const tag = 'desktop 1280x560 coarse pointer';

      expect(
        await page.evaluate(() => matchMedia('(pointer: coarse)').matches),
        `${tag}: the touch context reports a coarse pointer`,
      ).toBe(true);
      const reading = await readDesktopRail(page);
      expect(reading.documentScrolls, `${tag}: document must not scroll`).toBe(false);
      expect(reading.bottom, `${tag}: rail clears the light bar`).toBeLessThanOrEqual(
        560 - LIGHT_BAR_RESERVE + 0.5,
      );
      for (const [i, size] of reading.sizes.entries()) {
        expect(size.width, `${tag}: thumbnail ${i} is 44px`).toBeCloseTo(44, 1);
        expect(size.height, `${tag}: thumbnail ${i} is 44px`).toBeCloseTo(44, 1);
      }
      expect(reading.scrollHeight, `${tag}: rail scrolls below the coarse floor`).toBeGreaterThan(
        reading.clientHeight,
      );
      const ring = await focusRing(page, 6);
      expect(ring.inside, `${tag}: last thumbnail ring is not clipped`).toBe(true);
    });
  });

  test('synthetic safe areas and actionable point hit testing at phone portrait and short landscape', async ({
    page,
  }) => {
    skipUnlessWebgl2();

    const viewports = [
      { id: 'phone-390x844', width: 390, height: 844 },
      { id: 'short-landscape-844x390', width: 844, height: 390 },
    ];

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openScene(page);
      const safeArea = await installSafeArea(page);
      const tag = `${vp.id} synthetic safe area`;

      const safeRect = {
        left: safeArea.left,
        top: safeArea.top,
        right: vp.width - safeArea.right,
        bottom: vp.height - safeArea.bottom,
      };

      const rail = page.locator('#looks');
      const firstBtn = rail.locator('button').nth(0);
      const lastBtn = rail.locator('button').nth(6);
      const selectedBtn = rail.locator('button[aria-current="true"]');

      // 1. First thumbnail actionable point hit-test
      const firstBox = await firstBtn.boundingBox();
      expect(firstBox, `${tag}: first thumbnail has bounding box`).not.toBeNull();
      if (firstBox) {
        const actionX = firstBox.x + firstBox.width / 2;
        const actionY = firstBox.y + firstBox.height / 2;
        expect(actionX, `${tag}: first thumbnail actionX in safe rect`).toBeGreaterThanOrEqual(safeRect.left);
        expect(actionX, `${tag}: first thumbnail actionX in safe rect`).toBeLessThanOrEqual(safeRect.right);
        expect(actionY, `${tag}: first thumbnail actionY in safe rect`).toBeGreaterThanOrEqual(safeRect.top);
        expect(actionY, `${tag}: first thumbnail actionY in safe rect`).toBeLessThanOrEqual(safeRect.bottom);

        const hit = await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          const btn = document.querySelector('#looks button[data-look="wallis-dress"]');
          return el !== null && (el === btn || btn?.contains(el));
        }, { x: actionX, y: actionY });
        expect(hit, `${tag}: elementFromPoint hits first thumbnail directly (unoccluded)`).toBe(true);
      }

      // 2. Selected thumbnail hit-test
      const selectedBox = await selectedBtn.boundingBox();
      expect(selectedBox, `${tag}: selected thumbnail has bounding box`).not.toBeNull();
      if (selectedBox) {
        const actionX = selectedBox.x + selectedBox.width / 2;
        const actionY = selectedBox.y + selectedBox.height / 2;
        const hit = await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          const btn = document.querySelector('#looks button[aria-current="true"]');
          return el !== null && (el === btn || btn?.contains(el));
        }, { x: actionX, y: actionY });
        expect(hit, `${tag}: elementFromPoint hits selected thumbnail directly`).toBe(true);
      }

      // 3. Last thumbnail scrolled into view hit-test
      await lastBtn.scrollIntoViewIfNeeded();
      const lastBox = await lastBtn.boundingBox();
      expect(lastBox, `${tag}: last thumbnail has bounding box after scroll`).not.toBeNull();
      if (lastBox) {
        const actionX = lastBox.x + lastBox.width / 2;
        const actionY = lastBox.y + lastBox.height / 2;
        expect(actionX, `${tag}: last thumbnail actionX in safe rect`).toBeGreaterThanOrEqual(safeRect.left);
        expect(actionX, `${tag}: last thumbnail actionX in safe rect`).toBeLessThanOrEqual(safeRect.right);
        expect(actionY, `${tag}: last thumbnail actionY in safe rect`).toBeGreaterThanOrEqual(safeRect.top);
        expect(actionY, `${tag}: last thumbnail actionY in safe rect`).toBeLessThanOrEqual(safeRect.bottom);

        const hit = await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          const btn = document.querySelector('#looks button[data-look="geoffrey-beene"]');
          return el !== null && (el === btn || btn?.contains(el));
        }, { x: actionX, y: actionY });
        expect(hit, `${tag}: elementFromPoint hits last thumbnail directly`).toBe(true);
      }

      // 4. Keyboard focused thumbnail hit-test
      const secondBtn = rail.locator('button').nth(1);
      await secondBtn.focus();
      const focusBox = await secondBtn.boundingBox();
      expect(focusBox, `${tag}: focused thumbnail has bounding box`).not.toBeNull();
      if (focusBox) {
        const actionX = focusBox.x + focusBox.width / 2;
        const actionY = focusBox.y + focusBox.height / 2;
        const hit = await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          const btn = document.activeElement;
          return el !== null && (el === btn || btn?.contains(el));
        }, { x: actionX, y: actionY });
        expect(hit, `${tag}: elementFromPoint hits focused thumbnail directly`).toBe(true);
      }
    }
  });

  test('actionable point hit testing, clipping proof, and non-occlusion at desktop and tablet', async ({
    page,
  }) => {
    skipUnlessWebgl2();

    const viewports = [
      { id: 'desktop', width: 1440, height: 900 },
      { id: 'tablet', width: 820, height: 1180 },
    ];

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openScene(page);
      const tag = `${vp.id} hit testing`;

      const rail = page.locator('#looks');
      const firstBtn = rail.locator('button').nth(0);
      const lastBtn = rail.locator('button').nth(6);

      // 1. First thumbnail
      const firstBox = await firstBtn.boundingBox();
      expect(firstBox, `${tag}: first thumbnail has bounding box`).not.toBeNull();
      if (firstBox) {
        const hit = await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          const btn = document.querySelector('#looks button[data-look="wallis-dress"]');
          return el !== null && (el === btn || btn?.contains(el));
        }, { x: firstBox.x + firstBox.width / 2, y: firstBox.y + firstBox.height / 2 });
        expect(hit, `${tag}: elementFromPoint resolves to first thumbnail`).toBe(true);
      }

      // 2. Last thumbnail scrolled into view
      await lastBtn.scrollIntoViewIfNeeded();
      const lastBox = await lastBtn.boundingBox();
      expect(lastBox, `${tag}: last thumbnail has bounding box`).not.toBeNull();
      if (lastBox) {
        const hit = await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          const btn = document.querySelector('#looks button[data-look="geoffrey-beene"]');
          return el !== null && (el === btn || btn?.contains(el));
        }, { x: lastBox.x + lastBox.width / 2, y: lastBox.y + lastBox.height / 2 });
        expect(hit, `${tag}: elementFromPoint resolves to last thumbnail`).toBe(true);
      }

      // 3. Focused thumbnail
      const thirdBtn = rail.locator('button').nth(2);
      await thirdBtn.scrollIntoViewIfNeeded();
      await thirdBtn.focus();
      const thirdBox = await thirdBtn.boundingBox();
      if (thirdBox) {
        const hit = await page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          const btn = document.activeElement;
          return el !== null && (el === btn || btn?.contains(el));
        }, { x: thirdBox.x + thirdBox.width / 2, y: thirdBox.y + thirdBox.height / 2 });
        expect(hit, `${tag}: elementFromPoint resolves to focused thumbnail`).toBe(true);
      }
    }
  });

  test('selection via pointer, Enter, Space, and focus continuity across breakpoints', async ({
    page,
  }) => {
    skipUnlessWebgl2();
    await page.setViewportSize({ width: 1440, height: 900 });
    const canvas = await openScene(page);

    const rail = page.locator('#looks');
    const buttons = rail.locator('button');

    // 1. Pointer selection
    await buttons.nth(1).click();
    await expect(canvas).toHaveAttribute('data-look', 'zoot-suit', { timeout: SWITCH_TIMEOUT });
    await expect(buttons.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(buttons.nth(0)).not.toHaveAttribute('aria-current');

    // 2. Keyboard Enter selection
    await buttons.nth(2).focus();
    await page.keyboard.press('Enter');
    await expect(canvas).toHaveAttribute('data-look', 'new-look-dress', { timeout: SWITCH_TIMEOUT });
    await expect(buttons.nth(2)).toHaveAttribute('aria-current', 'true');
    await expect(buttons.nth(1)).not.toHaveAttribute('aria-current');

    // 3. Keyboard Space selection
    await buttons.nth(3).focus();
    await page.keyboard.press('Space');
    await expect(canvas).toHaveAttribute('data-look', 'mondrian-dress', { timeout: SWITCH_TIMEOUT });
    await expect(buttons.nth(3)).toHaveAttribute('aria-current', 'true');
    await expect(buttons.nth(2)).not.toHaveAttribute('aria-current');

    // 4. Focus continuity across desktop <-> tablet resize in both directions
    await buttons.nth(4).focus();
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.look)).toBe(
      'jumpsuit-dress',
    );

    // Resize to tablet
    await page.setViewportSize({ width: 820, height: 1180 });
    expect(
      await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.look),
      'focus preserved after resize to tablet',
    ).toBe('jumpsuit-dress');

    // Resize back to desktop
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(
      await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.look),
      'focus preserved after resize back to desktop',
    ).toBe('jumpsuit-dress');
  });

  test('latest-click-wins race condition with deterministic route delay', async ({ page }) => {
    skipUnlessWebgl2();
    await page.setViewportSize({ width: 1440, height: 900 });
    const canvas = await openScene(page);

    const rail = page.locator('#looks');
    const btnJumpsuit = rail.locator('button[data-look="jumpsuit-dress"]');
    const btnBlueSilk = rail.locator('button[data-look="blue-silk-dress"]');

    await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);
    const startId = await canvas.getAttribute('data-look');
    expect(startId, 'the starting look is published').not.toBeNull();
    const memoryBefore = await canvas.getAttribute('data-memory');
    expect(memoryBefore, 'the initialized memory baseline is published').not.toBeNull();
    const hold = await holdFirstRequest(page, '**/content/looks/jumpsuit-dress.glb', SWITCH_TIMEOUT);
    try {
      await btnJumpsuit.click();
      await hold.waitUntilEntered();
      // Wait for the held request's busy state before superseding it.
      await expect(btnJumpsuit).toHaveAttribute('aria-busy', 'true', { timeout: SWITCH_TIMEOUT });
      await btnBlueSilk.click();
    } finally {
      hold.release();
    }
    await hold.waitUntilContinued();

    // The winning look must be blue silk dress
    await expect(canvas).toHaveAttribute('data-look', 'blue-silk-dress', { timeout: SWITCH_TIMEOUT });
    await expect(page.locator('.product-card h2')).toHaveText('Blue Silk Dress');
    await expect(btnBlueSilk).toHaveAttribute('aria-current', 'true');
    await expect(btnJumpsuit).not.toHaveAttribute('aria-current');

    // No buttons remain busy
    await expect(rail.locator('[aria-busy="true"]')).toHaveCount(0);
    // Return to the same initialized look so leaked loser resources change the live GPU count.
    await rail.locator(`button[data-look="${String(startId)}"]`).click();
    await expect(canvas).toHaveAttribute('data-look', String(startId), { timeout: SWITCH_TIMEOUT });
    await expect(canvas).toHaveAttribute('data-fade', '0', { timeout: SWITCH_TIMEOUT });
    // Wait for the disposal draw to publish the original resource count.
    await expect(canvas).toHaveAttribute('data-memory', String(memoryBefore), { timeout: SWITCH_TIMEOUT });

    await page.unroute('**/content/looks/jumpsuit-dress.glb');
  });

  test('controlled pending and busy state capture and semantic reading', async ({ page }) => {
    skipUnlessWebgl2();
    await page.setViewportSize({ width: 1440, height: 900 });
    await openScene(page);

    const rail = page.locator('#looks');
    const targetBtn = rail.locator('button[data-look="new-look-dress"]');

    let resumeRoute: (() => void) | null = null;
    const routePromise = new Promise<void>((resolve) => {
      resumeRoute = resolve;
    });

    await page.route('**/content/looks/new-look-dress.glb', async (route) => {
      await routePromise;
      await route.continue();
    });

    // Click target to trigger pending switch
    await targetBtn.click();

    // Immediately verify aria-busy is set
    await expect(targetBtn).toHaveAttribute('aria-busy', 'true', { timeout: 5000 });

    // Verify semantic readings of the busy state
    await expect.poll(async () => {
      return Number(await targetBtn.evaluate((el) => getComputedStyle(el).opacity));
    }).toBeCloseTo(0.6, 1);

    const busyReading = await targetBtn.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        ariaBusy: el.getAttribute('aria-busy'),
        cursor: style.cursor,
        ariaCurrent: el.getAttribute('aria-current'),
      };
    });

    expect(busyReading.ariaBusy).toBe('true');
    expect(busyReading.cursor).toBe('wait');

    // Release the route so it finishes loading
    if (resumeRoute !== null) {
      (resumeRoute as () => void)();
    }

    // Now it settles
    await expect(targetBtn).not.toHaveAttribute('aria-busy', { timeout: SWITCH_TIMEOUT });
    await expect(targetBtn).toHaveAttribute('aria-current', 'true');

    await page.unroute('**/content/looks/new-look-dress.glb');
  });

  test('renderer preservation and demand loop return to idle', async ({ page }) => {
    skipUnlessWebgl2();
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const canvas = await openScene(page);

    await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);
    const initialMetrics = await page.evaluate(() => {
      const cv = document.querySelector<HTMLCanvasElement>('canvas#scene');
      const camera = window.archvizCamera;
      const hooks = window.archvizE2E;
      if (!cv || !camera || !hooks) throw new Error('handles unavailable');
      const rect = cv.getBoundingClientRect();
      const desc = hooks.describeScene();
      return {
        cssWidth: rect.width,
        cssHeight: rect.height,
        backingWidth: cv.width,
        backingHeight: cv.height,
        backend: cv.dataset.backend,
        cameraMode: camera.mode,
        meshes: desc.meshes,
      };
    });

    // Switch look to zoot-suit and back to wallis-dress
    const rail = page.locator('#looks');
    await rail.locator('button[data-look="zoot-suit"]').click();
    await expect(canvas).toHaveAttribute('data-look', 'zoot-suit', { timeout: SWITCH_TIMEOUT });

    await rail.locator('button[data-look="wallis-dress"]').click();
    await expect(canvas).toHaveAttribute('data-look', 'wallis-dress', { timeout: SWITCH_TIMEOUT });

    await waitForLoopIdle(page);

    const finalMetrics = await page.evaluate(() => {
      const cv = document.querySelector<HTMLCanvasElement>('canvas#scene');
      const camera = window.archvizCamera;
      const hooks = window.archvizE2E;
      if (!cv || !camera || !hooks) throw new Error('handles unavailable');
      const rect = cv.getBoundingClientRect();
      const desc = hooks.describeScene();
      return {
        cssWidth: rect.width,
        cssHeight: rect.height,
        backingWidth: cv.width,
        backingHeight: cv.height,
        backend: cv.dataset.backend,
        cameraMode: camera.mode,
        meshes: desc.meshes,
      };
    });

    expect(finalMetrics.cssWidth).toBe(initialMetrics.cssWidth);
    expect(finalMetrics.cssHeight).toBe(initialMetrics.cssHeight);
    expect(finalMetrics.backend).toBe(initialMetrics.backend);
    expect(finalMetrics.cameraMode).toBe(initialMetrics.cameraMode);
    expect(finalMetrics.meshes).toBe(initialMetrics.meshes);
  });
});
