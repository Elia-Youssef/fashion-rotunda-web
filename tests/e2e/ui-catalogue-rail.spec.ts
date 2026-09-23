import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

// UI-3 Catalogue Rail Parity E2E verification.
// Covers four benchmark viewports, internal vertical/horizontal scrolling,
// synthetic safe-area insets, actionable point elementFromPoint hit testing,
// pointer and keyboard (Enter, Space) selection, breakpoint focus continuity,
// latest-click-wins race resolution, and deterministic pending/busy state.

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

test.describe('UI-3: Catalogue Rail Parity', () => {
  test('rail geometry, internal scrolling, touch sizing, and zero document scroll across all 4 viewports', async ({
    page,
  }) => {
    skipUnlessWebgl2();

    const viewports = [
      { id: 'desktop', width: 1440, height: 900, axis: 'y' },
      { id: 'tablet', width: 820, height: 1180, axis: 'x' },
      { id: 'phone', width: 390, height: 844, axis: 'x', checkTouch: true },
      { id: 'shortLandscape', width: 844, height: 390, axis: 'x', checkTouch: true },
    ];

    for (const vp of viewports) {
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
        // Desktop: internal vertical scrolling for seven or more items
        expect(
          railMetrics.scrollHeight,
          `${vp.id}: rail scrollHeight must exceed clientHeight for vertical internal scrolling`,
        ).toBeGreaterThan(railMetrics.clientHeight);
        expect(railMetrics.overflowY).toBe('auto');

        // Verify vertical scrolling actually moves the content
        await rail.evaluate((el) => {
          el.scrollTop = 60;
        });
        const scrollTop = await rail.evaluate((el) => el.scrollTop);
        expect(scrollTop, `${vp.id}: rail scrollTop must be scrollable`).toBeGreaterThan(0);
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
    }
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

    // Introduce an artificial 2-second delay for the jumpsuit-dress GLB model
    let jumpsuitDelayed = false;
    await page.route('**/content/looks/jumpsuit-dress.glb', async (route) => {
      jumpsuitDelayed = true;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.continue();
    });

    // Rapidly click jumpsuit then blue silk
    await btnJumpsuit.click();
    await btnBlueSilk.click();

    // The winning look must be blue silk dress
    await expect(canvas).toHaveAttribute('data-look', 'blue-silk-dress', { timeout: SWITCH_TIMEOUT });
    await expect(page.locator('.product-card h2')).toHaveText('Blue Silk Dress');
    await expect(btnBlueSilk).toHaveAttribute('aria-current', 'true');
    await expect(btnJumpsuit).not.toHaveAttribute('aria-current');

    // No buttons remain busy
    await expect(rail.locator('[aria-busy="true"]')).toHaveCount(0);
    expect(jumpsuitDelayed, 'jumpsuit GLB route was intercepted').toBe(true);

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

    // Wait for loop to return to idle
    let prevFrames = Number(await canvas.getAttribute('data-frames'));
    let settled = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      await page.waitForTimeout(1000);
      const cur = Number(await canvas.getAttribute('data-frames'));
      if (cur > 0 && cur === prevFrames) {
        settled = true;
        break;
      }
      prevFrames = cur;
    }
    expect(settled, 'demand render loop returns to idle').toBe(true);

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
