import { expect, test } from './support/fixtures';
import { openShowroom } from './support/showroom';
import { SAFE_AREA, installSafeArea } from './support/safe-area';

const SCENE_READY_TIMEOUT = 60_000;
// Onboarding mounts with the a11y module after the ready attribute is published, so the card
// waits for the scene-initialization budget instead of the assertion default.
const A11Y_MOUNT_TIMEOUT = SCENE_READY_TIMEOUT;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boxesIntersect(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  test(`the onboarding Lights guide respects safe areas at ${viewport.width}x${viewport.height}`, async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    // The check reads DOM boxes, the safe-area tokens and one aria state, none of which the
    // renderer backend changes, so both projects run it against their own pinned backend.
    await openShowroom(page, request, '/?e2e=1&onboarding=1');
    const card = page.locator('.onboarding-card');
    // Onboarding mounts with the a11y module after the ready attribute is published.
    await expect(card).toBeVisible({ timeout: A11Y_MOUNT_TIMEOUT });
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
