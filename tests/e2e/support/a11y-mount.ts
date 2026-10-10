import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The accessibility module mounts after the heavy initialization stage: main.ts calls mountA11y
 * only once shader compilation and the first drawn frame are done, so canvas[data-scene="ready"]
 * never proves it. mountA11y appends the page's single tooltip surface before it mounts onboarding
 * and decides whether to start it, and that remainder runs synchronously in the same task, so the
 * surface proves the whole mount landed. A hover or focus sent earlier is lost, because the
 * pointerover and focusin listeners do not exist yet and events are not replayed.
 */
export async function waitForTooltipInstallation(page: Page, timeout: number): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.getElementById('a11y-tooltip') !== null), {
      timeout,
      message: 'the a11y module installed its tooltip surface',
    })
    .toBe(true);
}
