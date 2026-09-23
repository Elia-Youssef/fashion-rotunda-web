import { expect, test, type Page } from '@playwright/test';

const SCENE_READY_TIMEOUT = 60_000;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SAFE_AREA = { top: 19, right: 23, bottom: 29, left: 17 };

function skipUnlessWebgl2(): void {
  test.skip(test.info().project.name !== 'webgl2', 'the onboarding layout check is backend independent');
}

function boxesIntersect(a: Box, b: Box): boolean {
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

for (const viewport of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  test(`the onboarding Lights guide respects safe areas at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    skipUnlessWebgl2();
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    await page.goto('/?webgl=1&e2e=1&onboarding=1');
    await expect(page.locator('canvas#scene')).toHaveAttribute('data-scene', 'ready', {
      timeout: SCENE_READY_TIMEOUT,
    });
    const card = page.locator('.onboarding-card');
    await expect(card).toBeVisible();
    // The Light guide is positioned when its step appears. Install non-zero insets before the
    // two transitions that reach it, as a browser with a physical cut-out has them at startup.
    await installSafeArea(page);
    await card.getByRole('button', { name: 'Next' }).click();
    await card.getByRole('button', { name: 'Next' }).click();
    await expect(card.locator('.onboarding-card__title')).toHaveText('Adjust lighting');

    const guideBox = await card.boundingBox();
    const launcher = page.locator('#shell-light-toggle');
    const launcherBox = await launcher.boundingBox();
    expect(guideBox, 'the onboarding guide has a box').not.toBeNull();
    expect(launcherBox, 'the Light Control launcher has a box').not.toBeNull();
    if (guideBox === null || launcherBox === null) {
      return;
    }

    expect(guideBox.x, 'the guide clears the left safe inset').toBeGreaterThanOrEqual(SAFE_AREA.left);
    expect(guideBox.y, 'the guide clears the top safe inset').toBeGreaterThanOrEqual(SAFE_AREA.top);
    expect(
      guideBox.x + guideBox.width,
      'the guide clears the right safe inset',
    ).toBeLessThanOrEqual(viewport.width - SAFE_AREA.right);
    expect(
      guideBox.y + guideBox.height,
      'the guide clears the bottom safe inset',
    ).toBeLessThanOrEqual(viewport.height - SAFE_AREA.bottom);
    expect(
      boxesIntersect(guideBox, launcherBox),
      'the guide leaves its Light Control target actionable',
    ).toBe(false);

    await launcher.click();
    await expect(launcher).toHaveAttribute('aria-expanded', 'true');
  });
}
