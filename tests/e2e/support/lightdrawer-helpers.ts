import { expect } from './fixtures';
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test';


export const SCENE_READY_TIMEOUT = 60_000;

export const SAFE_AREA = { top: 19, right: 23, bottom: 29, left: 17 } as const;

export const STUDIO_LIGHTS = ['key', 'fill', 'back'] as const;

export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, sheet: false },
  { name: 'tablet', width: 820, height: 1180, sheet: false },
  { name: 'phone', width: 390, height: 844, sheet: true },
  { name: 'short-landscape', width: 844, height: 390, sheet: true },
] as const;

// The desktop bar matrix: the client's window (1669x1115 CSS), the common laptop sizes, and the
// smallest window that still gets the desktop layout.
export const DESKTOP_BAR_VIEWPORTS = [
  { width: 1669, height: 1115 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 720 },
  { width: 1200, height: 640 },
] as const;

export interface BarControl {
  id: string;
  width: number;
  height: number;
  bottom: number;
  hit: boolean;
  hitName: string;
}

export interface DesktopBar {
  toggle: { x: number; y: number; width: number; height: number };
  panel: { left: number; top: number; right: number; bottom: number };
  scroll: { height: number; clientHeight: number; width: number; clientWidth: number };
  columns: Array<{ light: string; top: number; left: number; right: number }>;
  /** null when the selector matched nothing, which the tests treat as a failure. */
  overlaps: Record<string, boolean | null>;
  controls: BarControl[];
}

export async function installSafeArea(page: Page): Promise<void> {
  await page.evaluate((insets) => {
    const root = document.documentElement;
    root.style.setProperty('--safe-area-top', `${insets.top}px`);
    root.style.setProperty('--safe-area-right', `${insets.right}px`);
    root.style.setProperty('--safe-area-bottom', `${insets.bottom}px`);
    root.style.setProperty('--safe-area-left', `${insets.left}px`);
  }, SAFE_AREA);
}

export async function assertHitAndSafe(
  locator: Locator,
  viewport: { width: number; height: number },
  label: string,
): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const reading = await locator.evaluate((node) => {
    const element = node as HTMLElement;
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      rect: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      hit: hit === element || element.contains(hit),
      hitName: `${hit?.tagName ?? 'null'}#${(hit as HTMLElement | null)?.id ?? ''}.${String((hit as HTMLElement | null)?.className ?? '')}`,
    };
  });

  expect(reading.rect.left, `${label}: clears left safe inset`).toBeGreaterThanOrEqual(
    SAFE_AREA.left,
  );
  expect(reading.rect.top, `${label}: clears top safe inset`).toBeGreaterThanOrEqual(SAFE_AREA.top);
  expect(reading.rect.right, `${label}: clears right safe inset`).toBeLessThanOrEqual(
    viewport.width - SAFE_AREA.right,
  );
  expect(reading.rect.bottom, `${label}: clears bottom safe inset`).toBeLessThanOrEqual(
    viewport.height - SAFE_AREA.bottom,
  );
  expect(reading.rect.width, `${label}: has a 44px pointer width`).toBeGreaterThanOrEqual(44);
  expect(reading.rect.height, `${label}: has a 44px pointer height`).toBeGreaterThanOrEqual(44);
  expect(reading.hit, `${label}: center belongs to the control; hit ${reading.hitName}`).toBe(true);
}

/** The open desktop bar: its box, columns, controls, and whether it touches the other chrome. */
export async function readDesktopBar(page: Page): Promise<DesktopBar> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('#shell-light-panel');
    const toggle = document.querySelector<HTMLElement>('#shell-light-toggle');
    if (panel === null || toggle === null) throw new Error('light row is unavailable');
    const box = panel.getBoundingClientRect();
    const toggleBox = toggle.getBoundingClientRect();
    const intersects = (other: Element | null): boolean | null => {
      if (other === null) return null;
      const r = other.getBoundingClientRect();
      return box.left < r.right && r.left < box.right && box.top < r.bottom && r.top < box.bottom;
    };
    return {
      toggle: { x: toggleBox.x, y: toggleBox.y, width: toggleBox.width, height: toggleBox.height },
      panel: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      scroll: {
        height: panel.scrollHeight,
        clientHeight: panel.clientHeight,
        width: panel.scrollWidth,
        clientWidth: panel.clientWidth,
      },
      columns: [...panel.querySelectorAll<HTMLElement>('.lightpanel__row')].map((row) => {
        const r = row.getBoundingClientRect();
        return { light: row.dataset.light ?? '', top: r.top, left: r.left, right: r.right };
      }),
      overlaps: {
        rail: intersects(document.querySelector('#looks')),
        card: intersects(document.querySelector('#shell-card')),
        badge: intersects(document.querySelector('.badge')),
        'proof strip': intersects(document.querySelector('#shell-proof')),
        'music switch': intersects(document.querySelector('header button.music-switch')),
        'mode switch': intersects(document.querySelector('.archviz-mode-switch')),
      },
      controls: [...panel.querySelectorAll<HTMLInputElement>('input')].map((input) => {
        const r = input.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          id: input.id,
          width: r.width,
          height: r.height,
          bottom: r.bottom,
          hit: hit === input || input.contains(hit),
          hitName: `${hit?.tagName ?? 'null'}#${(hit as HTMLElement | null)?.id ?? ''}`,
        };
      }),
    };
  });
}

export async function setNativeInput(locator: Locator, value: string): Promise<void> {
  await locator.evaluate((node, next) => {
    const input = node as HTMLInputElement;
    input.value = next;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

export async function expectRigAndUrl(page: Page, expected: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.archvizE2E?.rigState() ?? null), { timeout: 30_000 })
    .toBe(expected);
  await expect.poll(() => new URL(page.url()).searchParams.get('rig'), { timeout: 30_000 }).toBe(expected);
}

export async function expectDefaultRigWithoutUrl(page: Page, expected: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.archvizE2E?.rigState() ?? null), { timeout: 30_000 })
    .toBe(expected);
  await expect.poll(() => new URL(page.url()).searchParams.get('rig'), { timeout: 30_000 }).toBeNull();
}

export async function proofDrawCalls(page: Page): Promise<number | null> {
  return await page.evaluate(() => {
    const term = [...document.querySelectorAll<HTMLElement>('.proof-panel__term')].find(
      (node) => node.textContent === 'draw calls',
    );
    const match = term?.nextElementSibling?.textContent?.match(/^(\d+) calls$/);
    return match === undefined || match === null ? null : Number(match[1]);
  });
}

export async function newTouchPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: 'http://localhost:4173',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    hasTouch: true,
    isMobile: true,
  });
  return { context, page: await context.newPage() };
}
