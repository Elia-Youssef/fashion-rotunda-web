import { expect, test } from './support/fixtures';
import { openShowroom } from './support/showroom';

const SCENE_TIMEOUT_MS = 60_000;

for (const tier of ['base', 'mid', 'high']) {
  test(`thumbnail requests follow the first scene frame at ${tier}`, async ({ page, request }) => {
    // Routing disables the HTTP cache so every thumbnail has a Resource Timing entry.
    await page.route('**/thumbs/**', (route) => route.continue());
    await openShowroom(page, request, `/?e2e=1&gate=off&proof=1&tier=${tier}`);
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll<HTMLImageElement>(
        '.catalog-strip__thumb, .product-card__thumb',
      )];
      return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0);
    }, undefined, { timeout: SCENE_TIMEOUT_MS });
    const reading = await page.evaluate(() => {
      const mark = performance.getEntriesByName('first-frame', 'mark')[0];
      const images = [...document.querySelectorAll<HTMLImageElement>(
        '.catalog-strip__thumb, .product-card__thumb',
      )];
      const urls = [...new Set(images.map((image) => image.src))];
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      return {
        mark: mark?.startTime ?? null,
        urls,
        requests: resources.filter((entry) => new URL(entry.name).pathname.includes('/thumbs/'))
          .map((entry) => ({ name: entry.name, startTime: entry.startTime })),
      };
    });
    expect(reading.mark).not.toBeNull();
    expect(reading.urls.length).toBeGreaterThan(0);
    for (const url of reading.urls) {
      expect(reading.requests.some((request) => request.name === url), url).toBe(true);
    }
    for (const request of reading.requests) {
      expect(request.startTime, request.name).toBeGreaterThanOrEqual(reading.mark!);
    }
  });
}
