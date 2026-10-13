import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** The final hook is installed after shader compilation and the initialization draw. */
export async function waitForSceneInitialization(page: Page, timeout: number): Promise<void> {
  // Wait for a complete final-hook read before taking baselines or sending fixture operations.
  await expect
    .poll(() => page.evaluate(() => window.archvizE2E?.rigState() ?? null), {
      timeout,
      message: 'the final scene hook can read the initialized rig',
    })
    .not.toBeNull();
}

// Numeric polling keeps diagnostics observable even when animation-frame delivery is stalled.
export const LOOP_STATE_POLL_MS = 100;
// Initialization/compilation can take as long as the existing scene readiness gate.
const LOOP_IDLE_TIMEOUT_MS = 60_000;
// Matches the existing input-to-drawn-frame handshake budget.
const LOOP_FRESH_FRAME_TIMEOUT_MS = 5_000;
// More than seven 30 fps touch-frame intervals, after owner-confirmed idle and a fresh frame.
const LOOP_QUIET_MS = 250;

/** Proves owner-confirmed idle, live frame delivery, then a short no-new-frame interval. */
export async function waitForLoopIdle(page: Page): Promise<number> {
  const idle = await page.waitForFunction(() => {
    const state = window.archvizE2E?.loopState();
    return state?.initialized === true && state.idle && state.frames > 0;
  }, undefined, { polling: LOOP_STATE_POLL_MS, timeout: LOOP_IDLE_TIMEOUT_MS });
  await idle.dispose();

  const before = await page.evaluate(() => window.archvizE2E!.requestFrame());
  const fresh = await page.waitForFunction((baseline) => {
    const state = window.archvizE2E?.loopState();
    return state?.initialized === true && state.idle && state.frames > baseline ? state.frames : false;
  }, before, { polling: LOOP_STATE_POLL_MS, timeout: LOOP_FRESH_FRAME_TIMEOUT_MS });
  const frames = await fresh.jsonValue();
  await fresh.dispose();

  await page.waitForTimeout(LOOP_QUIET_MS);
  const after = await page.evaluate(() => window.archvizE2E?.loopState());
  if (after?.initialized !== true || !after.idle || after.frames !== frames) {
    throw new Error('render loop left idle or drew a new frame during the quiet observation');
  }
  return frames;
}
