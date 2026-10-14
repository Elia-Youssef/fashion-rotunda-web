import { chromium, expect, test as base } from '@playwright/test';
import type { Browser, LaunchOptions, Page } from '@playwright/test';
import { ErrorGuard } from './error-guard';

const pageGuards = new WeakMap<Page, ErrorGuard>();

function guardFor(page: Page): ErrorGuard {
  const guard = pageGuards.get(page);
  if (!guard) throw new Error('Page is not registered with the browser error fixture');
  return guard;
}

export function expectConsoleError(page: Page, pattern: RegExp, reason: string): void {
  guardFor(page).expectError(page, 'console', pattern, reason);
}

/** Read diagnostics without adding a second page listener. */
export function browserReports(page: Page): ReturnType<ErrorGuard['reports']> {
  return guardFor(page).reports(page);
}

export async function settleBrowserReports(page: Page): Promise<void> {
  await guardFor(page).settled();
}

interface Fixtures {
  errorGuard: ErrorGuard;
  guardedBrowser: Browser;
  launchBrowser: (options: LaunchOptions) => Promise<Browser>;
}

export const test = base.extend<Fixtures>({
  errorGuard: [async ({ context }, use) => {
    const guard = new ErrorGuard((page) => pageGuards.set(page, guard));
    // All context pages, including popups, register before their first navigation.
    guard.watchContext(context);
    try {
      await use(guard);
    } finally {
      try {
        await guard.assertClean();
      } finally {
        guard.dispose();
      }
    }
  }, { auto: true }],
  guardedBrowser: async ({ browser, errorGuard }, use) => {
    await use(errorGuard.browser(browser));
  },
  launchBrowser: async ({ errorGuard }, use) => {
    await use(async (options) => errorGuard.browser(await chromium.launch(options)));
  },
});

export { expect };
