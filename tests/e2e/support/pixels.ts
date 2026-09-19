import type { Locator } from '@playwright/test';
import { PNG } from 'pngjs';

export interface CanvasStats {
  width: number;
  height: number;
  distinctColours: number;
  nonBackgroundRatio: number;
}

/**
 * Decodes the element screenshot with pngjs and reduces it to four numbers. The background is the
 * most frequent colour of the frame, whatever it is, so nonBackgroundRatio is the share of pixels
 * that differ from it.
 */
export async function canvasStats(locator: Locator): Promise<CanvasStats> {
  const png = PNG.sync.read(await locator.screenshot());
  const counts = new Map<number, number>();
  for (let i = 0; i < png.data.length; i += 4) {
    // Alpha is dropped from the key: r-g-b is the colour identity the assertions care about, and
    // every pixel of a rendered frame is opaque anyway.
    const key = (png.data[i] << 16) | (png.data[i + 1] << 8) | png.data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const pixels = png.width * png.height;
  // A loop, not Math.max(...counts.values()): a textured frame carries more distinct colours than the
  // engine accepts as spread arguments, and that throws a RangeError instead of returning a number.
  let backgroundPixels = 0;
  for (const count of counts.values()) {
    backgroundPixels = Math.max(backgroundPixels, count);
  }
  return {
    width: png.width,
    height: png.height,
    distinctColours: counts.size,
    nonBackgroundRatio: (pixels - backgroundPixels) / pixels,
  };
}
