import type { Page } from '@playwright/test';

export const SAFE_AREA = { top: 19, right: 23, bottom: 29, left: 17 } as const;

export type SafeArea = typeof SAFE_AREA;

/** A non-zero synthetic cut-out proves the token abstraction rather than Chromium's zero env(). */
export async function installSafeArea(page: Page): Promise<SafeArea> {
  await page.evaluate((insets) => {
    const root = document.documentElement;
    root.style.setProperty('--safe-area-top', `${insets.top}px`);
    root.style.setProperty('--safe-area-right', `${insets.right}px`);
    root.style.setProperty('--safe-area-bottom', `${insets.bottom}px`);
    root.style.setProperty('--safe-area-left', `${insets.left}px`);
  }, SAFE_AREA);
  return SAFE_AREA;
}
