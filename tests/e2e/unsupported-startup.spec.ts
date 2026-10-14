import { expect, test } from './support/fixtures';
import type { Page } from '@playwright/test';

// Startup with no startable backend: Chromium launched with its graphics APIs disabled still
// exposes navigator.gpu and WebGL2RenderingContext, but grants neither an adapter nor a context.
// The lobby must not stay loading forever: after the Load press the unsupported surface appears,
// Load stays disabled, the hidden retry button is not drawn, and no /content/ request left the
// page. The webgl2 project only; this spec launches its own browser, like the probe spec it
// follows, because the flags must not disturb the shared project browser.

const DISABLED_GRAPHICS_FLAGS = ['--disable-webgl', '--disable-webgl2', '--disable-features=WebGPU'];

function skipUnlessWebgl2(): void {
  test.skip(test.info().project.name !== 'webgl2', 'webgl2 project Chromium only');
}

function watchContentRequests(page: Page): () => string[] {
  const contentUrls: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/content/')) {
      contentUrls.push(new URL(url).pathname);
    }
  });
  return () => [...contentUrls];
}

async function readSurface(page: Page): Promise<{
  paneVisible: boolean;
  paneRole: string | null;
  title: string | null;
  message: string | null;
  loadDisabled: boolean | null;
  retryHidden: boolean | 'until-found' | null;
  retryDrawn: boolean;
}> {
  return page.evaluate(() => {
    const pane = document.querySelector<HTMLElement>('.entry-lobby__error-pane');
    const load = document.querySelector<HTMLButtonElement>('#lobby-load-btn');
    const retry = document.querySelector<HTMLButtonElement>('#lobby-retry-btn');
    const retryStyle = retry === null ? null : window.getComputedStyle(retry);
    return {
      paneVisible: pane !== null && pane.offsetParent !== null,
      paneRole: pane?.getAttribute('role') ?? null,
      title: pane?.querySelector('.entry-lobby__error-title')?.textContent ?? null,
      message: pane?.querySelector('.entry-lobby__error-message')?.textContent ?? null,
      loadDisabled: load?.disabled ?? null,
      retryHidden: retry?.hidden ?? null,
      // Computed, not the attribute: a display value from the stylesheet must not draw a
      // button the markup hides.
      retryDrawn: retry !== null && retry.offsetParent !== null && retryStyle?.display !== 'none',
    };
  });
}

test('flags: unsupported surface after Load, no retry drawn, no content request', async ({ baseURL, launchBrowser }) => {
  skipUnlessWebgl2();
  const browser = await launchBrowser({ headless: true, args: DISABLED_GRAPHICS_FLAGS });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const contentUrls = watchContentRequests(page);

    await page.goto(`${baseURL}/`);
    const lobby = page.locator('#entry-lobby');
    await expect(lobby).toHaveAttribute('data-state', 'idle');

    // The deferred-load contract: nothing leaves the page before the gesture.
    await page.waitForTimeout(1000);
    expect(contentUrls(), 'zero content requests before the press').toEqual([]);

    await lobby.locator('#lobby-load-btn').click();

    // The adapter and context probes answer after the press; the lobby ends on the
    // unsupported surface, never on an eternal loading state.
    await expect(lobby).toHaveAttribute('data-state', 'error', { timeout: 15_000 });

    const surface = await readSurface(page);
    expect(surface.paneVisible).toBe(true);
    expect(surface.paneRole).toBe('alert');
    expect(surface.title?.toLowerCase()).toBe('3d unavailable');
    expect(surface.message).toBe(
      'This exhibition requires WebGPU or WebGL 2. Your graphics browser does not support these features.',
    );
    expect(surface.loadDisabled).toBe(true);
    expect(surface.retryHidden).toBe(true);
    expect(surface.retryDrawn, 'the hidden retry button must not be drawn').toBe(false);

    // Startup never reached the catalogue: no content request at all.
    await page.waitForTimeout(1000);
    expect(contentUrls(), 'zero content requests on the unsupported path').toEqual([]);
  } finally {
    await browser.close();
  }
});

test('deleted APIs: unsupported surface at mount, retry button not drawn', async ({ baseURL, launchBrowser }) => {
  skipUnlessWebgl2();
  const browser = await launchBrowser({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const contentUrls = watchContentRequests(page);
    await page.addInitScript(() => {
      const navProto = Navigator.prototype as unknown as Record<string, unknown>;
      if ('gpu' in navProto) {
        try {
          delete navProto.gpu;
        } catch {
          /* not configurable in this build; the probe facts below will say so */
        }
      }
      const globalScope = window as unknown as Record<string, unknown>;
      if ('WebGL2RenderingContext' in globalScope) {
        try {
          delete globalScope.WebGL2RenderingContext;
        } catch {
          /* not configurable in this build; the probe facts below will say so */
        }
      }
    });

    await page.goto(`${baseURL}/`);
    const lobby = page.locator('#entry-lobby');
    await expect(lobby).toHaveAttribute('data-state', 'idle');

    // The deletion must really have happened, or the rest of this test proves nothing.
    const probe = await page.evaluate(() => ({
      gpuInNavigator: 'gpu' in navigator,
      webgl2Ctor: 'WebGL2RenderingContext' in window,
    }));
    expect(probe).toEqual({ gpuInNavigator: false, webgl2Ctor: false });

    const surface = await readSurface(page);
    expect(surface.paneVisible).toBe(true);
    expect(surface.paneRole).toBe('alert');
    expect(surface.title?.toLowerCase()).toBe('3d unavailable');
    expect(surface.loadDisabled).toBe(true);
    expect(surface.retryHidden).toBe(true);
    expect(surface.retryDrawn, 'the hidden retry button must not be drawn').toBe(false);

    // The Load action is dead on this surface and nothing may be fetched.
    await page.waitForTimeout(1000);
    expect(contentUrls(), 'zero content requests without a startable backend').toEqual([]);
  } finally {
    await browser.close();
  }
});
