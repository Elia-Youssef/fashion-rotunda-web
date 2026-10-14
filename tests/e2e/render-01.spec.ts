import { expect, test, browserReports, settleBrowserReports } from './support/fixtures';
import type { Page } from '@playwright/test';

import { canvasGrowths, recordTextureCopies } from './support/texture-copy-recorder';
import type { TextureCopyRecord, TextureCopyWindow } from './support/texture-copy-recorder';

// The dome glass copies both the pre-pass and scene pass. Their cloned textures used to share one
// size record, so only the first copy reallocated when the resolution scaler changed the buffer.
// A shrink and return to the original allocation cannot expose that defect. Deterministically shrink,
// rebuild the graph in a new CSS box at that scale, then grow past the rebuilt allocation while
// retaining the graph. Record native copy ranges so missing console warnings cannot hide the defect.
// Freeze scaler and governor samples; machine load must not change either part of this sequence.
const SCENE_PATH = '/?gate=off&e2e=1&proof=1&music=off&attract=0&tier=mid';
// Mid has GTAO's pre-pass without a startup benchmark or compute-only effects.
const VIEWPORT = { width: 1440, height: 900 } as const;
// A different CSS box retires the old graph and allocates both glass copies at the reduced scale.
const REBUILD_VIEWPORT = { width: 1400, height: 875 } as const;
// Keep the slow-load allowance; phase waits depend on drawn frames rather than elapsed recovery time.
const SCENE_READY_TIMEOUT_MS = 240_000;
const FRAME_TIMEOUT_MS = 15_000;
// Four light changes exercise both scene draws repeatedly after the full-scale buffer is applied.
const LIGHT_CHANGE_COUNT = 4;
const TEST_TIMEOUT_MS = SCENE_READY_TIMEOUT_MS + (LIGHT_CHANGE_COUNT + 4) * FRAME_TIMEOUT_MS + 60_000;
const COLORS = ['#ff9a3c', '#3c9aff', '#ffffff'] as const;
const COPY_ERROR = /GPUValidationError|Texture copy range/;

test.use({ viewport: VIEWPORT, deviceScaleFactor: 1 });

async function readRecord(page: Page): Promise<TextureCopyRecord> {
  return page.evaluate(() => {
    const record = (window as unknown as TextureCopyWindow).__textureCopyRecord;
    if (record === undefined) {
      throw new Error('The texture-copy recorder was not installed before navigation');
    }
    return record;
  });
}

/** Change the Key colour at rest, then observe a newer drawn frame instead of sleeping. */
async function drawLightFrame(page: Page, round: number): Promise<void> {
  const before = await page.evaluate(() =>
    Number(document.querySelector<HTMLCanvasElement>('canvas#scene')?.dataset.frames));
  await page.locator('[data-light="key"] .lightpanel__color').evaluate((node, color) => {
    const input = node as HTMLInputElement;
    input.value = color;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, COLORS[round % COLORS.length]);
  await page.waitForFunction((frames) =>
    Number(document.querySelector<HTMLCanvasElement>('canvas#scene')?.dataset.frames) > frames,
  before, { timeout: FRAME_TIMEOUT_MS });
}

test('scaler growth at rest leaves no out-of-range WebGPU texture copies', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgpu', 'native texture-copy validation needs the WebGPU project');
  test.setTimeout(TEST_TIMEOUT_MS);
  await page.addInitScript(recordTextureCopies);
  await page.goto(SCENE_PATH, { timeout: SCENE_READY_TIMEOUT_MS });
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT_MS });
  await expect(canvas, 'precondition: a real WebGPU run, never a silent fallback')
    .toHaveAttribute('data-backend', 'webgpu');
  // Scene-ready can precede the camera and test handles on a native GPU.
  await page.waitForFunction(() => window.archvizCamera !== undefined && window.archvizE2E !== undefined,
    undefined, { timeout: SCENE_READY_TIMEOUT_MS });
  await page.waitForFunction(() =>
    Number(document.querySelector<HTMLCanvasElement>('canvas#scene')?.dataset.frames) > 0,
  undefined, { timeout: FRAME_TIMEOUT_MS });
  await expect(canvas, 'precondition: AO supplies the second scene draw needed for the shared-size defect')
    .toHaveAttribute('data-post', /(?:^|,)ao(?:,|$)/, { timeout: FRAME_TIMEOUT_MS });

  await page.evaluate(() => {
    const controls = window.archvizE2E;
    if (controls === undefined) {
      throw new Error('the scaler test handle must exist');
    }
    controls.governor.setDeterministic(true);
    controls.scaler.setDeterministic(true);
    const { steps } = controls.scaler.diagnostics();
    controls.scaler.step(steps.indexOf(Math.min(...steps)));
  });
  await drawLightFrame(page, 0);

  // Rebuild while held at the smallest tier step. A subsequent light change proves a frame in the
  // new box even when a broken scaler handle did nothing; the growth precondition must catch that.
  const beforeResize = await readRecord(page);
  await page.setViewportSize(REBUILD_VIEWPORT);
  await page.waitForFunction(({ checkpoint, viewport }) => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas#scene');
    const record = (window as unknown as TextureCopyWindow).__textureCopyRecord;
    return canvas?.clientWidth === viewport.width && canvas.clientHeight === viewport.height &&
      record?.canvas.slice(checkpoint).some((assignment) => assignment.axis === 'width' &&
        assignment.boxWidth === viewport.width && assignment.boxHeight === viewport.height);
  }, { checkpoint: beforeResize.canvas.length, viewport: REBUILD_VIEWPORT }, { timeout: FRAME_TIMEOUT_MS });
  await drawLightFrame(page, 1);
  await expect(canvas, 'precondition: the rebuilt graph still includes the AO pre-pass')
    .toHaveAttribute('data-post', /(?:^|,)ao(?:,|$)/, { timeout: FRAME_TIMEOUT_MS });
  const beforeGrowth = await readRecord(page);
  const rebuildWidth = beforeGrowth.canvas.slice(beforeResize.canvas.length).find((assignment) =>
    assignment.axis === 'width' && assignment.boxWidth === REBUILD_VIEWPORT.width)?.to;
  if (rebuildWidth === undefined) {
    throw new Error('precondition: the rebuild must record its drawing-buffer width');
  }
  const rebuiltScaler = await page.evaluate(() => window.archvizE2E?.scaler.diagnostics());

  await page.evaluate(() => {
    const controls = window.archvizE2E;
    if (controls === undefined) {
      throw new Error('the scaler test handle must exist');
    }
    const { steps } = controls.scaler.diagnostics();
    controls.scaler.step(steps.indexOf(Math.max(...steps)));
  });
  for (let round = 0; round < LIGHT_CHANGE_COUNT; round += 1) {
    await drawLightFrame(page, round + 2);
  }
  await settleBrowserReports(page);
  const copyReports = browserReports(page).filter((report) => COPY_ERROR.test(report.detail));
  const record = await readRecord(page);
  const grownScaler = await page.evaluate(() => window.archvizE2E?.scaler.diagnostics());
  await test.info().attach('texture-copy-record', {
    body: JSON.stringify({ record, rebuildWidth, rebuiltScaler, grownScaler,
      consoleAndPageErrors: copyReports }, null, 2),
    contentType: 'application/json',
  });

  expect(record.installed, 'precondition: the native GPU copy hook was installed').toBe(true);
  expect(record.copyCount, 'precondition: the hook observed real texture copies').toBeGreaterThan(0);
  expect(record.errors, 'recorder failures must not hide invalid copies').toEqual([]);
  expect(
    canvasGrowths(record.canvas, beforeGrowth.canvas.length),
    `precondition: the scaler must grow the buffer with its CSS box unchanged: ${JSON.stringify(record.canvas)}`,
  ).toBeGreaterThan(0);
  const grownWidth = Math.max(...record.canvas.slice(beforeGrowth.canvas.length)
    .filter((assignment) => assignment.axis === 'width').map((assignment) => assignment.to));
  expect(
    grownWidth,
    `precondition: the growth must pass the width of the rebuild (${rebuildWidth}), or no stale copy can overflow`,
  ).toBeGreaterThan(rebuildWidth);
  expect.soft(
    record.copies.length,
    `${record.copies.length} out-of-range texture copies; first: ${JSON.stringify(record.copies[0] ?? null)}`,
  ).toBe(0);
  expect(copyReports, `extra WebGPU error check; first: ${copyReports[0] ?? 'none'}`).toEqual([]);
});
