import { expect, test } from './support/fixtures';
import { installSafeArea } from './support/safe-area';
import { openShowroom } from './support/showroom';
import { RAIL_PATH } from './support/catalogue-rail';

test.describe('Catalogue Rail Parity', () => {
  test('synthetic safe areas and actionable point hit testing at phone portrait and short landscape', async ({
    page,
    request,
  }) => {
    const viewports = [
      { id: 'phone-390x844', width: 390, height: 844 },
      { id: 'short-landscape-844x390', width: 844, height: 390 },
    ];

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openShowroom(page, request, RAIL_PATH);
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
    request,
  }) => {
    const viewports = [
      { id: 'desktop', width: 1440, height: 900 },
      { id: 'tablet', width: 820, height: 1180 },
    ];

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openShowroom(page, request, RAIL_PATH);
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
});
