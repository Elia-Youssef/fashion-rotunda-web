import { expect, test, expectConsoleError } from './support/fixtures';

import { SCENE_READY_TIMEOUT } from './support/ready';
import {
  enterExperience,
  expectRevealComplete,
  openTransition,
} from './support/scene-reveal';

// Gating and failure: music, onboarding, keyboard and pointer input stay deferred
// until the reveal completes, and a failed reveal shows its retry surface.

// A 100 px yaw drag at 0.005 rad/px moves the proof camera about 2 m. 0.1 m rejects
// unchanged poses and spherical round-trip noise while allowing a partially applied gesture.
const MIN_REVEALED_DRAG_M = 0.1;
// Input wakes the render loop immediately; 5 s allows slow frames without reaching the idle tour.
const REVEALED_DRAG_TIMEOUT_MS = 5_000;
// Bounds the wait for the armed music player to reach playing once the reveal completes.
const MUSIC_PLAYING_TIMEOUT_MS = 15_000;

test.describe('Scene Reveal Transition', () => {
  test('defers music and onboarding until the reveal has completed', async ({ page }) => {
    const { backend, lobby, veil, canvas } = await openTransition(page, {
      freeze: 'black-hold',
      music: 'on',
      onboarding: true,
    });
    await enterExperience(lobby, canvas, backend);
    await expect(veil).toHaveAttribute('data-state', 'black-hold', { timeout: SCENE_READY_TIMEOUT });

    const underBlack = await page.evaluate(() => ({
      music: window.archvizMusic?.state(),
      onboardingCards: document.querySelectorAll('.onboarding-card').length,
      headerMusic: document.querySelector<HTMLElement>('#shell-header button.music-switch')?.dataset.music,
    }));
    expect(underBlack.music, 'deferred player remains off while the veil is frozen').toBe('off');
    expect(underBlack.headerMusic, 'the control is only armed while loading').toBe('armed');
    expect(underBlack.onboardingCards, 'onboarding has not mounted behind the veil').toBe(0);

    await page.evaluate(() => window.archvizTransitionSeam?.unfreeze());
    await expectRevealComplete(page);
    await expect(page.locator('#shell-header button.music-switch')).toHaveAttribute('data-music', 'playing', {
      timeout: MUSIC_PLAYING_TIMEOUT_MS,
    });
    await expect(page.locator('.onboarding-card')).toBeVisible();
    expect(await page.evaluate(() => window.archvizMusic?.state())).toBe('playing');
  });

  test('fails closed into a visible, pointer-operable retry surface', async ({ page }) => {
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'ready-hidden' });
    await enterExperience(lobby, canvas, backend);
    await expect(veil).toHaveAttribute('data-state', 'ready-hidden', { timeout: SCENE_READY_TIMEOUT });

    expectConsoleError(page, /^\[archviz\] transition error Injected transition failure$/,
      'the test deliberately fails the reveal to verify its retry surface');
    await page.evaluate(() => window.archvizReveal?.fail('Injected transition failure'));
    await expect(lobby).toHaveAttribute('data-state', 'error');
    await expect(veil).toBeHidden();
    const retry = lobby.getByRole('button', { name: 'RETRY LOADING' });
    await expect(retry).toBeVisible();

    const retryHit = await retry.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === element || element.contains(hit);
    });
    expect(retryHit).toBe(true);
  });

  test('keeps the showroom keyboard-inert throughout black-hold', async ({ page }) => {
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'black-hold' });
    await enterExperience(lobby, canvas, backend);
    await expect(veil).toHaveAttribute('data-state', 'black-hold', { timeout: SCENE_READY_TIMEOUT });

    await expect(page.locator('#shell-header')).toHaveAttribute('inert', '');
    await expect(page.locator('main')).toHaveAttribute('inert', '');
    await expect(page.locator('footer')).toHaveAttribute('inert', '');
    await page.keyboard.press('Tab');
    const focusOwner = await page.evaluate(() => document.activeElement?.closest('#entry-lobby, #scene')?.id ?? null);
    expect(focusOwner, 'keyboard navigation cannot reach the scene under black').not.toBe('scene');

    await page.evaluate(() => window.archvizTransitionSeam?.unfreeze());
    await expectRevealComplete(page);
  });

  test('blocks pointer input until revealed, then enables camera interaction', async ({ page }) => {
    // Freeze at black-hold
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'black-hold' });
    await enterExperience(lobby, canvas, backend);
    await expect(veil).toHaveAttribute('data-state', 'black-hold', { timeout: SCENE_READY_TIMEOUT });

    // Canvas cannot be hit while veil is active
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();
    const hitElement = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el?.id ?? el?.tagName.toLowerCase();
    }, { x: canvasBox!.x + canvasBox!.width / 2, y: canvasBox!.y + canvasBox!.height / 2 });

    expect(['scene-veil', 'entry-lobby'], 'hit target is veil or lobby').toContain(hitElement);

    // Unfreeze
    await page.evaluate(() => window.archvizTransitionSeam?.unfreeze());
    await expectRevealComplete(page);

    // After reveal: dragging canvas rotates camera
    const readCameraFrame = (): Promise<{ position: [number, number, number]; frames: number }> =>
      page.evaluate(() => {
        const camera = window.archvizCamera;
        const scene = document.querySelector<HTMLCanvasElement>('canvas#scene');
        if (camera === undefined || scene?.dataset.frames === undefined) {
          throw new Error('the revealed camera or frame counter is unavailable');
        }
        return { position: camera.orbit.position, frames: Number(scene.dataset.frames) };
      });
    const before = await readCameraFrame();

    // Drag on canvas
    await page.mouse.move(canvasBox!.x + canvasBox!.width / 2, canvasBox!.y + canvasBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvasBox!.x + canvasBox!.width / 2 + 100, canvasBox!.y + canvasBox!.height / 2);
    await page.mouse.up();

    // One reading must prove camera displacement and a frame drawn after the pre-drag baseline.
    await expect
      .poll(async () => {
        const after = await readCameraFrame();
        const moved = Math.hypot(
          after.position[0] - before.position[0],
          after.position[1] - before.position[1],
          after.position[2] - before.position[2],
        );
        return moved >= MIN_REVEALED_DRAG_M && after.frames > before.frames;
      }, {
        message: 'the revealed drag moved the camera and drew a new frame',
        timeout: REVEALED_DRAG_TIMEOUT_MS,
      })
      .toBe(true);
  });
});
