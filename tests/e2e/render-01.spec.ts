import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

import { canvasGrowths, recordTextureCopies } from './support/texture-copy-recorder';
import type { TextureCopyRecord, TextureCopyWindow } from './support/texture-copy-recorder';

// The dome glass copies the framebuffer twice in the enhanced post chain. A scaler growth used to
// leave one GPU texture at its previous size. Record the actual copy ranges, even if Chrome is silent.
// Keep the normal tier selection and governor: forcing a post slice changes the load that reproduces it.
const SCENE_PATH = '/?gate=off&e2e=1&proof=1&music=off';
// The reproducing load uses this desktop viewport and its default DPR of 1.
const VIEWPORT = { width: 1440, height: 900 } as const;
// Throttle from navigation so the scaler can shrink before the post chain allocates its textures.
const THROTTLE_RATE = 8;
const UNTHROTTLED_RATE = 1;
// Allow the same slow-load window as the reproducing sequence, plus time for recovery and diagnostics.
const SCENE_READY_TIMEOUT_MS = 240_000;
const TEST_TIMEOUT_MS = 300_000;
// 24 changes keep the at-rest loop awake long enough for its five-second scaler recovery window.
const LIGHT_CHANGE_COUNT = 24;
// Half a second between changes gives the post chain frames to draw and the scaler samples to recover.
const LIGHT_CHANGE_WAIT_MS = 500;
const COLORS = ['#ff9a3c', '#3c9aff', '#ffffff'] as const;
const COPY_ERROR = /GPUValidationError|Texture copy range/;

test.use({ viewport: VIEWPORT, deviceScaleFactor: 1 });

interface ErrorWatch {
  reports: string[];
  settled(): Promise<void>;
}

/** Read object arguments too: the renderer's WebGPU error message can be truncated in text(). */
async function describeConsoleMessage(message: ConsoleMessage): Promise<string> {
  const parts = await Promise.all(message.args().map((handle) => handle.evaluate((value: unknown) => {
    if (typeof value === 'object' && value !== null && 'message' in value) {
      const kind = 'type' in value && typeof value.type === 'string' ? `${value.type}: ` : '';
      return `${kind}${String(value.message)}`;
    }
    return String(value);
  }).catch(() => '')));
  return `${message.text()} | ${parts.join(' | ')}`;
}

/** Extra diagnostics for the whole run; the native copy recorder is the primary check. */
function watchErrors(page: Page): ErrorWatch {
  const reports: string[] = [];
  const pending: Promise<void>[] = [];
  const note = (text: string): void => {
    if (COPY_ERROR.test(text)) {
      reports.push(text);
    }
  };
  page.on('console', (message) => {
    const type = message.type();
    if (type !== 'error' && type !== 'warning') {
      return;
    }
    if (reports.length > 0) {
      note(message.text());
      return;
    }
    pending.push(describeConsoleMessage(message).then((text) => note(`console ${type}: ${text}`)));
  });
  page.on('pageerror', (error) => note(`page error: ${error.name}: ${error.message}`));
  return { reports, settled: async () => { await Promise.all(pending); } };
}

async function readRecord(page: Page): Promise<TextureCopyRecord> {
  return page.evaluate(() => {
    const record = (window as unknown as TextureCopyWindow).__textureCopyRecord;
    if (record === undefined) {
      throw new Error('The texture-copy recorder was not installed before navigation');
    }
    return record;
  });
}

/** Toggle the panel and change the Key colour without orbiting or otherwise moving the camera. */
async function changeLights(page: Page, round: number): Promise<void> {
  await page.locator('#shell-light-toggle').click();
  await page.locator('[data-light="key"] .lightpanel__color').evaluate((node, color) => {
    const input = node as HTMLInputElement;
    input.value = color;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, COLORS[round % COLORS.length]);
  await page.waitForTimeout(LIGHT_CHANGE_WAIT_MS);
}

test('scaler growth at rest leaves no out-of-range WebGPU texture copies', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgpu', 'native texture-copy validation needs the WebGPU project');
  test.setTimeout(TEST_TIMEOUT_MS);
  const watch = watchErrors(page);
  await page.addInitScript(recordTextureCopies);
  const devtools = await page.context().newCDPSession(page);
  try {
    await devtools.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE_RATE });
    await page.goto(SCENE_PATH, { timeout: SCENE_READY_TIMEOUT_MS });
    const canvas = page.locator('canvas#scene');
    await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT_MS });
    await expect(canvas, 'a real WebGPU run, never a silent fallback').toHaveAttribute('data-backend', 'webgpu');

    // Capture the checkpoint before releasing the throttle, so startup assignments cannot prove recovery.
    const before = await readRecord(page);
    await devtools.send('Emulation.setCPUThrottlingRate', { rate: UNTHROTTLED_RATE });
    for (let round = 0; round < LIGHT_CHANGE_COUNT; round += 1) {
      await changeLights(page, round);
    }
    await watch.settled();
    const record = await readRecord(page);
    await test.info().attach('texture-copy-record', {
      body: JSON.stringify({ record, consoleAndPageErrors: watch.reports }, null, 2),
      contentType: 'application/json',
    });

    expect.soft(record.installed, 'the native GPU copy hook was installed').toBe(true);
    expect.soft(record.copyCount, 'the hook observed real texture copies, so zero errors is meaningful')
      .toBeGreaterThan(0);
    expect.soft(record.errors, 'recorder failures must not hide invalid copies').toEqual([]);
    expect.soft(
      canvasGrowths(record.canvas, before.canvas.length),
      `the scaler must grow the buffer after release with its CSS box unchanged: ${JSON.stringify(record.canvas)}`,
    ).toBeGreaterThan(0);
    expect.soft(
      record.copies.length,
      `${record.copies.length} out-of-range texture copies; first: ${JSON.stringify(record.copies[0] ?? null)}`,
    ).toBe(0);
    expect(watch.reports, `extra WebGPU error check; first: ${watch.reports[0] ?? 'none'}`).toEqual([]);
  } finally {
    // Restore the session even when a readiness or assertion gate fails.
    await devtools.send('Emulation.setCPUThrottlingRate', { rate: UNTHROTTLED_RATE });
    await devtools.detach();
  }
});
