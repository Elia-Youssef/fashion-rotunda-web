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
