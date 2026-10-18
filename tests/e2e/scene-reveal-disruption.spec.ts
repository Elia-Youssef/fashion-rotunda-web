import { expect, test } from './support/fixtures';
import type { Page } from '@playwright/test';

import { SCENE_READY_TIMEOUT } from './support/ready';
import { assertDisruptionReset, assertFreshStableFrames } from './support/reveal-disruption';
import {
  HANDSHAKE_TIMEOUT_MS,
  VIEWPORTS,
  enterExperience,
  expectRevealComplete,
  openTransition,
} from './support/scene-reveal';

// Disruption restarts: a viewport resize, a hidden tab and an orientation change
// each park the black-frame handshake and rerun it before the reveal.

// Waits until the handshake is parked at the `?freeze=black-hold` seam with its two stable frames.
// `stableFrames` only grows from 0 to 2 while the veil reads black-hold, and the seam then holds it
// at 2 until unfreeze() or a disruption. `timestamps.holdEnd` is recorded immediately before the
// coordinator parks at that freeze, so a disruption sent afterwards lands on a parked coordinator and
// leaves `stableFrames` at 0 instead of racing a handshake that restarts and counts back up to 2.
// Both fields come from one synchronous read. `holdEnd` is not cleared by a restart, so call this
// only before the first disruption.
async function expectParkedBehindBlack(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const seam = window.archvizTransitionSeam;
          return seam === undefined || seam.timestamps.holdEnd === null ? -1 : seam.stableFrames;
        }),
      {
        message: 'two stable frames were drawn behind black and the black-hold freeze was reached',
        timeout: HANDSHAKE_TIMEOUT_MS,
      },
    )
    .toBeGreaterThanOrEqual(2);
}

test.describe('Scene Reveal Transition', () => {
  test('restarts the black-frame handshake after viewport disruption before revealing', async ({ page }) => {
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'black-hold' });
    await enterExperience(lobby, canvas, backend);
    await expect(veil).toHaveAttribute('data-state', 'black-hold', { timeout: SCENE_READY_TIMEOUT });
    await expectParkedBehindBlack(page);

    const target = VIEWPORTS.find((viewport) => viewport.name === 'tablet')!;
    const before = await page.evaluate(() => {
      const seam = window.archvizTransitionSeam;
      if (seam === undefined) throw new Error('guarded transition diagnostics are unavailable');
      return {
        generation: seam.generation,
        disruptions: seam.disruptions.length,
        parked: seam.parked,
        width: window.innerWidth,
        height: window.innerHeight,
      };
    });
    expect(before.parked, 'the coordinator is latched at the black-hold freeze before resizing').toBe(true);
    expect(before.width !== target.width || before.height !== target.height, 'the viewport change is real').toBe(true);

    await page.setViewportSize({ width: target.width, height: target.height });
    const readResize = () => page.evaluate(({ start, width, height }) =>
      window.archvizTransitionSeam?.disruptions.slice(start).find((record) =>
        record.source === 'window' && record.type === 'resize' && record.width === width && record.height === height,
      ) ?? null, { start: before.disruptions, width: target.width, height: target.height });
    await expect
      .poll(readResize, { message: 'production window resize handler did not record delivery for the changed viewport' })
      .not.toBeNull();
    const reset = (await readResize())!;
    assertDisruptionReset(reset, before.generation);
    await expect(veil).toHaveAttribute('data-state', 'black-hold');
    await expect(veil).toBeVisible();
    await expect(veil).toHaveCSS('opacity', '1');

    const release = await page.evaluate(() => {
      const seam = window.archvizTransitionSeam;
      if (seam === undefined) throw new Error('guarded transition diagnostics are unavailable');
      return { parked: seam.parked, samples: seam.stableFrameSamples.length, stableFrames: seam.stableFrames };
    });
    expect(release.parked, 'the disruption leaves the black-hold latch closed until release').toBe(true);
    expect(release.stableFrames, 'no stable frame is counted while the disrupted handshake is parked').toBe(0);

    // Retain this observation handle before release; disposal unpublishes the global.
    const seam = await page.evaluateHandle(() => window.archvizTransitionSeam!);
    try {
      await seam.evaluate((value) => value.unfreeze());
      await expectRevealComplete(page);
      expect(await page.evaluate(() => window.archvizReveal?.frameCountBehindBlack)).toBeGreaterThanOrEqual(2);
      const freshSamples = await seam.evaluate((value, start) => value.stableFrameSamples.slice(start), release.samples);
      assertFreshStableFrames(freshSamples, reset.generation);
    } finally {
      await seam.dispose();
    }
  });

  test('waits for a hidden-tab restore, then reruns the black-frame handshake before reveal', async ({ page }) => {
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'black-hold' });
    await enterExperience(lobby, canvas, backend);
    await expect(veil).toHaveAttribute('data-state', 'black-hold', { timeout: SCENE_READY_TIMEOUT });
    await expectParkedBehindBlack(page);

    // An explicit visibility event gives both headless projects a deterministic hidden-tab restore.
    // This temporarily overrides the read-only document value in the isolated test page and
    // dispatches the browser lifecycle
    // event, exercising the production listener without adding a product test seam.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => window.archvizTransitionSeam?.stableFrames ?? -1)).toBe(0);
    await expect(veil).toHaveAttribute('data-state', 'black-hold');

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
      window.archvizTransitionSeam?.unfreeze();
    });
    await expectRevealComplete(page);
    expect(await page.evaluate(() => window.archvizReveal?.frameCountBehindBlack)).toBeGreaterThanOrEqual(2);
  });

  test('restarts the black-frame handshake after an orientation disruption before revealing', async ({ page }) => {
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'black-hold' });
    await enterExperience(lobby, canvas, backend);
    await expect(veil).toHaveAttribute('data-state', 'black-hold', { timeout: SCENE_READY_TIMEOUT });
    await expectParkedBehindBlack(page);

    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await expect.poll(() => page.evaluate(() => window.archvizTransitionSeam?.stableFrames ?? -1)).toBe(0);
    await expect(veil).toHaveAttribute('data-state', 'black-hold');

    await page.evaluate(() => window.archvizTransitionSeam?.unfreeze());
    await expectRevealComplete(page);
    expect(await page.evaluate(() => window.archvizReveal?.frameCountBehindBlack)).toBeGreaterThanOrEqual(2);
  });
});
