import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

// The overlay shell contract. The canvas is the full scene field beneath the chrome, so
// opening or closing the Light Control drawer must not move it, or anything else. The drawer
// starts closed on every review viewport, with ARIA, hidden and the visible state in agreement.
// webgl2 project only, like the chrome suite: the checks read the DOM, not the backend.

const SCENE_READY_TIMEOUT = 60_000;

function skipUnlessWebgl2(): void {
  test.skip(test.info().project.name !== 'webgl2', 'the shell checks are backend independent');
}

interface CanvasBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function readCanvasBox(page: Page): Promise<CanvasBox> {
  const box = await page.locator('canvas#scene').boundingBox();
  expect(box, 'the canvas has a bounding box').not.toBeNull();
  if (box === null) {
    throw new Error('the canvas has no bounding box');
  }
  return box;
}

interface Layout {
  canvas: CanvasBox;
  rail: CanvasBox | null;
  card: CanvasBox | null;
  scroll: { w: number; h: number; x: number; y: number };
}

/** Canvas CSS client box plus the rail, the card and the document scroll size, in one DOM pass. */
async function readLayout(page: Page): Promise<Layout> {
  return await page.evaluate((): Layout => {
    function box(id: string): CanvasBox | null {
      const el = document.getElementById(id);
      if (el === null) {
        return null;
      }
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    const scroller = document.scrollingElement;
    const canvas = box('scene');
    if (canvas === null) {
      throw new Error('the canvas is missing from the layout');
    }
    return {
      canvas,
      rail: box('looks'),
      card: box('shell-card'),
      scroll: {
        w: scroller ? scroller.scrollWidth : 0,
        h: scroller ? scroller.scrollHeight : 0,
        x: window.scrollX,
        y: window.scrollY,
      },
    };
  });
}

const REVIEW_VIEWPORTS: Array<{ name: string; width: number; height: number }> = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'short landscape', width: 844, height: 390 },
];

for (const viewport of REVIEW_VIEWPORTS) {
  test(`the light control starts closed at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    skipUnlessWebgl2();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/?webgl=1&gate=off&e2e=1');
    const canvas = page.locator('canvas#scene');
    await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

    const box = await readCanvasBox(page);
    expect(box.width, `${viewport.name}: the canvas keeps a positive width`).toBeGreaterThan(0);
    expect(box.height, `${viewport.name}: the canvas keeps a positive height`).toBeGreaterThan(0);

    const toggle = page.locator('#shell-light-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#shell-light-panel')).toBeHidden();
    // Visible state agrees: the closed root paints no box.
    const panelHeight = await page.evaluate(
      () => document.getElementById('shell-light-panel')?.getBoundingClientRect().height ?? -1,
    );
    expect(panelHeight, `${viewport.name}: the closed panel paints no box`).toBe(0);
  });
}

test('the desktop drawer opens over the canvas without moving anything', async ({ page }) => {
  skipUnlessWebgl2();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?webgl=1&gate=off&e2e=1');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

  const closed = await readLayout(page);
  expect(closed.canvas.width).toBe(1440);
  expect(closed.canvas.height).toBe(900);
  expect(closed.canvas.x).toBe(0);
  expect(closed.canvas.y).toBe(0);
  expect(closed.scroll.h, 'the page has no vertical scroll').toBeLessThanOrEqual(900);
  expect(closed.scroll.w, 'the page has no horizontal scroll').toBeLessThanOrEqual(1440);
  expect(closed.scroll.x).toBe(0);
  expect(closed.scroll.y).toBe(0);

  await page.locator('#shell-light-toggle').click();
  await expect(page.locator('#shell-light-panel')).toBeVisible();

  const open = await readLayout(page);
  expect(open.canvas).toEqual(closed.canvas);
  expect(open.rail).toEqual(closed.rail);
  expect(open.card).toEqual(closed.card);
  expect(open.scroll).toEqual(closed.scroll);

  // Closing returns to the same geometry.
  await page.locator('#shell-light-toggle').click();
  await expect(page.locator('#shell-light-panel')).toBeHidden();
  const closedAgain = await readLayout(page);
  expect(closedAgain.canvas).toEqual(closed.canvas);
});

test('opening and closing the drawer preserves the look, the card and the music', async ({ page }) => {
  skipUnlessWebgl2();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?webgl=1&gate=off&e2e=1&music=on');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

  const music = page.locator('header button.music-switch');
  const musicBefore = await music.getAttribute('aria-pressed');
  const cardBefore = await page.locator('.product-card h2').textContent();
  const lookBefore = await canvas.getAttribute('data-look');

  await page.locator('#shell-light-toggle').click();
  await expect(page.locator('#shell-light-panel')).toBeVisible();
  await page.locator('#shell-light-toggle').click();
  await expect(page.locator('#shell-light-panel')).toBeHidden();

  await expect(canvas).toHaveAttribute('data-look', lookBefore ?? '');
  expect(await page.locator('.product-card h2').textContent()).toBe(cardBefore);
  expect(await music.getAttribute('aria-pressed')).toBe(musicBefore);
});

for (const viewport of [
  { name: 'phone', width: 390, height: 844 },
  { name: 'short landscape', width: 844, height: 390 },
]) {
  test(`closed mobile sheet chrome cannot cover Light Control at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    skipUnlessWebgl2();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/?webgl=1&gate=off&e2e=1');
    await expect(page.locator('canvas#scene')).toHaveAttribute('data-scene', 'ready', {
      timeout: SCENE_READY_TIMEOUT,
    });

    const toggle = page.locator('#shell-light-toggle');
    const chrome = page.locator('#shell-light-row .shell-sheet__chrome');
    const close = chrome.getByRole('button', { name: 'Close' });
    await expect(chrome).toBeHidden();
    await expect.poll(() =>
      chrome.evaluate((element) => ({
        hidden: (element as HTMLElement).hidden,
        inert: (element as HTMLElement).inert,
        ariaHidden: element.getAttribute('aria-hidden'),
        closeTabIndex: element.querySelector<HTMLButtonElement>('.shell-sheet__close')?.tabIndex,
      })),
    ).toEqual({ hidden: true, inert: true, ariaHidden: 'true', closeTabIndex: -1 });

    // The next tab stop cannot be the hidden Close button.
    await toggle.focus();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.matches('.shell-sheet__close'))).toBe(false);

    // Four CSS pixels inside the right edge was the formerly intercepted region.
    const box = await toggle.boundingBox();
    expect(box, `${viewport.name}: Light Control has a pointer target`).not.toBeNull();
    if (box === null) {
      throw new Error('Light Control has no bounding box');
    }
    expect(
      await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.id,
        { x: box.x + box.width - 4, y: box.y + box.height / 2 },
      ),
      `${viewport.name}: its right edge belongs to the launcher`,
    ).toBe('shell-light-toggle');
    await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);

    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(chrome).toBeVisible();
    await expect(close).toBeVisible();
    await expect(close).toBeEnabled();
    await expect.poll(() =>
      chrome.evaluate((element) => ({
        hidden: (element as HTMLElement).hidden,
        inert: (element as HTMLElement).inert,
        ariaHidden: element.getAttribute('aria-hidden'),
        closeTabIndex: element.querySelector<HTMLButtonElement>('.shell-sheet__close')?.tabIndex,
      })),
    ).toEqual({ hidden: false, inert: false, ariaHidden: 'false', closeTabIndex: 0 });

    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(chrome).toBeHidden();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('shell-light-toggle');

    // The second mobile disclosure follows the same dismissal and focus-return contract.
    const look = page.locator('.shell-pill--look');
    await look.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#shell-card')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#shell-card')).toBeHidden();
    expect(await page.evaluate(() => document.activeElement?.matches('.shell-pill--look'))).toBe(true);
  });
}

test('Escape closes desktop Light Control and returns focus to its trigger', async ({ page }) => {
  skipUnlessWebgl2();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?webgl=1&gate=off&e2e=1');
  await expect(page.locator('canvas#scene')).toHaveAttribute('data-scene', 'ready', {
    timeout: SCENE_READY_TIMEOUT,
  });

  const toggle = page.locator('#shell-light-toggle');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#shell-light-panel')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#shell-light-panel')).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('shell-light-toggle');
});
