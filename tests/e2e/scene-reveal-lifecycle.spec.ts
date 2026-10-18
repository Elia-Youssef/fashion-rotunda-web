import { expect, test } from './support/fixtures';

import { holdFirstRequest } from './support/held-request';
import { SCENE_READY_TIMEOUT } from './support/ready';
import {
  HANDSHAKE_TIMEOUT_MS,
  VIEWPORTS,
  enterExperience,
  expectRevealComplete,
  openTransition,
} from './support/scene-reveal';

// The reveal lifecycle: the staged transition from the lobby's load press to the
// revealed scene, the veil states it passes through, and its responsiveness
// across every supported viewport.

// The held first rotunda request keeps the boot in loading until the test releases it, so the
// loading phase below is observed while held; 30 s covers a slow boot start under four software
// workers, and sits far below the 90 s test budget.
const LOADING_HOLD_TIMEOUT_MS = 30_000;

test.describe('Scene Reveal Transition', () => {
  test('executes two-stage reveal lifecycle in exact order with stable frames', async ({ page }) => {
    const { backend, lobby, canvas } = await openTransition(page);

    // The held rotunda request keeps the boot in loading, so the loading phase is observed while
    // it is held instead of raced against the content that ends it.
    const rotunda = await holdFirstRequest(page, '**/content/rotunda.glb', LOADING_HOLD_TIMEOUT_MS);

    // Click load
    await enterExperience(lobby, canvas, backend);
    await rotunda.waitUntilEntered();
    await expect(lobby).toHaveAttribute('data-state', 'loading');
    await rotunda.release();
    await rotunda.waitUntilContinued();

    // Wait for full transition to revealed
    await expect(lobby).toHaveCount(0, { timeout: SCENE_READY_TIMEOUT });
    await expectRevealComplete(page);
    await expect(lobby).toBeHidden();
    await expect(canvas).toHaveAttribute('data-scene', 'ready');

    // Completed diagnostics remain readable on the existing coordinator handle.
    const seamData = await page.evaluate(() => {
      const coordinator = window.archvizReveal;
      if (!coordinator) return null;
      return {
        state: coordinator.state,
        stableFrames: coordinator.frameCountBehindBlack,
        timestamps: coordinator.transitionTimestamps,
      };
    });

    expect(seamData, 'completed coordinator is available').not.toBeNull();
    if (seamData) {
      expect(seamData.state).toBe('revealed');
      expect(seamData.stableFrames).toBeGreaterThanOrEqual(2);

      const ts = seamData.timestamps;
      expect(ts.readyHidden, 'readyHidden recorded').not.toBeNull();
      expect(ts.coverStart, 'coverStart recorded').not.toBeNull();
      expect(ts.coverEnd, 'coverEnd recorded').not.toBeNull();
      expect(ts.holdStart, 'holdStart recorded').not.toBeNull();
      expect(ts.holdEnd, 'holdEnd recorded').not.toBeNull();
      expect(ts.revealStart, 'revealStart recorded').not.toBeNull();
      expect(ts.revealEnd, 'revealEnd recorded').not.toBeNull();

      expect(ts.readyHidden!).toBeLessThanOrEqual(ts.coverStart!);
      expect(ts.coverStart!).toBeLessThanOrEqual(ts.coverEnd!);
      expect(ts.coverEnd!).toBeLessThanOrEqual(ts.holdStart!);
      expect(ts.holdStart!).toBeLessThanOrEqual(ts.holdEnd!);
      expect(ts.holdEnd!).toBeLessThanOrEqual(ts.revealStart!);
      expect(ts.revealStart!).toBeLessThanOrEqual(ts.revealEnd!);
    }
  });

  test('proves solid black veil opacity and readiness predicates during black-hold', async ({ page }) => {
    // Freeze at black-hold using the deterministic seam
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'black-hold' });
    await enterExperience(lobby, canvas, backend);

    // Wait until transition freezes at black-hold
    await expect(veil).toHaveAttribute('data-state', 'black-hold', { timeout: SCENE_READY_TIMEOUT });

    // Assert computed style: solid black, 100% opaque
    const veilStyle = await veil.evaluate((el) => {
      const computed = window.getComputedStyle(el);
      return {
        opacity: computed.opacity,
        backgroundColor: computed.backgroundColor,
        zIndex: computed.zIndex,
        visibility: computed.visibility,
      };
    });

    expect(veilStyle.opacity).toBe('1');
    expect(['rgb(0, 0, 0)', '#000000']).toContain(veilStyle.backgroundColor);
    expect(Number(veilStyle.zIndex)).toBeGreaterThanOrEqual(100);

    // Verify all 16 predicates evaluated true during hold
    const predicateResults = await page.evaluate(() => {
      return window.archvizTransitionSeam?.readPredicates() ?? {};
    });

    for (const [pred, ok] of Object.entries(predicateResults)) {
      expect(ok, `predicate ${pred} is true`).toBe(true);
    }

    // Stable frames behind black >= 2. The veil turns black-hold before the frames are counted, so
    // this polls; the freeze holds the counter at 2 once it gets there.
    await expect
      .poll(() => page.evaluate(() => window.archvizTransitionSeam?.stableFrames ?? -1), {
        message: 'at least two stable frames were drawn behind black',
        timeout: HANDSHAKE_TIMEOUT_MS,
      })
      .toBeGreaterThanOrEqual(2);

    // Unfreeze and confirm graceful completion to revealed
    await page.evaluate(() => window.archvizTransitionSeam?.unfreeze());
    await expectRevealComplete(page);
  });

  test('freezes deterministic mid-reveal capture at a genuinely partial veil opacity', async ({ page }) => {
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'revealing' });
    await enterExperience(lobby, canvas, backend);
    await expect(veil).toHaveAttribute('data-state', 'revealing', { timeout: SCENE_READY_TIMEOUT });

    // The revealing seam holds a paused CSS animation at its negative-delay partial sample.
    // The sample stays fixed until unfreeze(), so observing the held state needs no delay.
    const reading = await veil.evaluate((element) => ({
      opacity: Number.parseFloat(getComputedStyle(element).opacity),
      revealEnd: window.archvizTransitionSeam?.timestamps.revealEnd ?? null,
    }));
    expect(reading.opacity).toBeGreaterThan(0);
    expect(reading.opacity).toBeLessThan(1);
    expect(reading.revealEnd).toBeNull();

    await page.evaluate(() => window.archvizTransitionSeam?.unfreeze());
    await expectRevealComplete(page);
  });

  test('keeps the branded ready-hidden lobby visible until cover-to-black begins', async ({ page }) => {
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'ready-hidden' });
    await enterExperience(lobby, canvas, backend);
    await expect(lobby).toHaveAttribute('data-state', 'ready-hidden', { timeout: SCENE_READY_TIMEOUT });
    await expect(veil).toHaveAttribute('data-state', 'ready-hidden');

    const composition = await page.evaluate(() => {
      const lobbyElement = document.querySelector<HTMLElement>('#entry-lobby');
      const veilElement = document.querySelector<HTMLElement>('#scene-veil');
      const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      return {
        lobbyVisibility: lobbyElement === null ? null : getComputedStyle(lobbyElement).visibility,
        veilVisibility: veilElement === null ? null : getComputedStyle(veilElement).visibility,
        veilOpacity: veilElement === null ? null : getComputedStyle(veilElement).opacity,
        hitLobby: hit?.closest('#entry-lobby') !== null,
      };
    });

    expect(composition.lobbyVisibility).toBe('visible');
    expect(composition.veilVisibility).toBe('hidden');
    expect(composition.veilOpacity).toBe('0');
    expect(composition.hitLobby).toBe(true);

    await page.evaluate(() => window.archvizTransitionSeam?.unfreeze());
    await expectRevealComplete(page);
  });

  for (const vp of VIEWPORTS) {
    test(`captures and verifies transition responsiveness at ${vp.name} (${vp.width}x${vp.height})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const { backend, lobby, canvas } = await openTransition(page);

      // Click load and await reveal
      await enterExperience(lobby, canvas, backend);
      await expectRevealComplete(page);

      // Verify zero scroll after reveal
      const scrollMetrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
      }));

      expect(scrollMetrics.scrollWidth, `${vp.name} has no horizontal scroll`).toBeLessThanOrEqual(scrollMetrics.clientWidth);
      expect(scrollMetrics.scrollHeight, `${vp.name} has no vertical scroll`).toBeLessThanOrEqual(scrollMetrics.clientHeight);
    });
  }
});
