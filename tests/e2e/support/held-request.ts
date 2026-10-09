import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Holds one matching request until the test has sent its competing intent. */
export async function holdFirstRequest(page: Page, url: string, timeout: number) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  let continued = false;
  await page.route(url, async (route) => {
    entered = true;
    await held;
    await route.continue();
    continued = true;
  }, { times: 1 });
  return {
    release,
    async waitUntilEntered(): Promise<void> {
      // Wait for the first fetch to enter the held route before the competing click.
      await expect.poll(() => entered, { timeout, message: 'the first request is held' }).toBe(true);
    },
    async waitUntilContinued(): Promise<void> {
      // Wait for route continuation before checking the settled winner and resource baseline.
      await expect.poll(() => continued, { timeout, message: 'the held route continued' }).toBe(true);
    },
  };
}
