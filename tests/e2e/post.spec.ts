import { expect, test } from './support/fixtures';
import { waitForLoopIdle, waitForSceneInitialization } from './support/ready';
import type { Locator, Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { canvasStats } from './support/pixels';

// The post chain's development slices on the WebGL 2 backend. Every URL below pins ?webgl=1, so
// both projects run these cases: the webgl2 project renders the pinned pages on the bundled
// Chromium's software WebGL 2, the webgpu project on the installed Chrome's GPU driver, which is
// the WebGL 2 implementation a visitor whose browser falls back actually gets. main.ts creates the
// chain once the tier settles and publishes its features string as data-post from the frame loop,
// so a canvas whose data-post never appears is a defect: the waits below fail instead of skipping.
// On this backend the tier decision is always mid (decide.ts lines 54-56), so the aa slice is TRAA
// and the ao slice is GTAO, deterministically.

const SCENE_READY_TIMEOUT = 60_000;
/**
 * data-post is written by the same frame loop that turned data-scene ready, not seconds later: the
 * pinned ?webgl=1 makes the backend webgl2 on both projects, so decideTier returns mid (decide.ts
 * lines 54-56), settleTier returns at its first line without running the benchmark, and the chain
 * is created and published within a frame or two of data-scene="ready". Ten seconds is therefore a
 * generous wait for something that is either already there or never coming, and a missing
 * data-post fails within it instead of stalling toward the test timeout.
 */
const POST_ATTRIBUTE_TIMEOUT = 10_000;
/**
 * The ssgi token tracks the governor's scale, not motion (chain.ts currentFeatures), and the
 * publisher writes the string from the frame loop, so after a drag release the full-resolution
 * token is either already published or lands on the next drawn frame; 3 s fails a downgrade
 * quickly instead of stalling toward the 120 s test timeout.
 */
const SSGI_RELEASE_TIMEOUT_MS = 3000;
/**
 * Motion keeps the dof token unpublished for MOTION_MS (500 ms, chain.ts), and the chain's stable
 * rest callback re-arms at MOTION_REST_DELAY_MS (510 ms) before it requests the redraw that turns
 * the token back on; 3 s is about six times that deadline, headroom for a loaded machine rather
 * than a matched budget.
 */
const DOF_REST_TIMEOUT_MS = 3000;

/**
 * The chain is created unconditionally once the tier settles (main.ts rebuildPostChain throws if it
 * cannot be built), and the post-state publisher writes the features string within a frame or two
 * of data-scene="ready". A canvas that never carries data-post is a wiring defect, so this wait
 * fails the test instead of skipping it.
 */
async function expectPublishedPostState(canvas: Locator): Promise<void> {
  await expect(canvas, 'the wired post chain publishes data-post on the canvas').toHaveAttribute(
    'data-post',
    /./,
    { timeout: POST_ATTRIBUTE_TIMEOUT },
  );
}

/** A drag must change the actual camera and draw its moving post state before release. */
async function expectDrawnDrag(
  page: Page,
  canvas: Locator,
  originX: number,
  originY: number,
  required: string[],
  forbidden: string[],
  alwaysAbsent: string[] = [],
): Promise<void> {
  await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);
  await page.mouse.move(originX, originY);
  await page.mouse.down();
  try {
    const before = await page.evaluate(() => ({
      position: [...window.archvizCamera!.orbit.position],
      frames: Number(document.querySelector<HTMLCanvasElement>('canvas#scene')!.dataset.frames),
    }));
    // A quarter-canvas horizontal drag stays inside the box and changes the orbit once.
    const box = await canvas.boundingBox();
    expect(box, 'the canvas remains available during the held drag').not.toBeNull();
    await page.mouse.move(originX + box!.width / 4, originY);
    const forbiddenSeen = new Set<string>();
    // Wait for one atomic camera, moving flag, frame-counter and post-token handshake.
    await expect.poll(async () => {
      const snapshot = await page.evaluate(() => ({
        position: [...window.archvizCamera!.orbit.position],
        moving: window.archvizCamera!.orbit.moving,
        frames: Number(document.querySelector<HTMLCanvasElement>('canvas#scene')!.dataset.frames),
        post: document.querySelector<HTMLCanvasElement>('canvas#scene')!.dataset.post ?? null,
      }));
      const moved = snapshot.position.some((value, axis) => value !== before.position[axis]);
      const drawn = snapshot.frames > before.frames;
      if (moved && drawn && snapshot.moving) {
        for (const token of alwaysAbsent) {
          if (hasPostToken(snapshot.post ?? '', token)) forbiddenSeen.add(token);
        }
      }
      return {
        moved,
        drawn,
        moving: snapshot.moving,
        published: snapshot.post !== null,
        forbiddenSeen: [...forbiddenSeen],
        required: required.map((token) => hasPostToken(snapshot.post ?? '', token)),
        forbidden: forbidden.map((token) => hasPostToken(snapshot.post ?? '', token)),
      };
    }, { timeout: POST_ATTRIBUTE_TIMEOUT, message: 'a drawn moving frame has the required post state' })
      .toEqual({
        moved: true,
        drawn: true,
        moving: true,
        published: true,
        forbiddenSeen: [],
        required: required.map(() => true),
        forbidden: forbidden.map(() => false),
      });
  } finally {
    await page.mouse.up();
  }
}

/**
 * data-post is a comma-separated token list in a fixed order: ao, traa, msaa, then the SSGI token
 * ('ssgi-half' at half resolution, 'ssgi' at full), 'ssr', then the finishing-pass tokens; the
 * literal string 'off' when nothing is on. The composition root writes it from chain.features.
 */
const POST_TOKEN_ORDER = [
  'ao',
  'traa',
  'msaa',
  'ssgi-half',
  'ssgi',
  'ssr',
  'bloom',
  'lut',
  'vignette',
  'dof',
];

/**
 * What each development slice publishes as data-post on the mid tier the pinned WebGL 2 backend
 * always earns on both projects. SSGI and SSR are absent from every row because the backend rules
 * them out, not because the slice does.
 */
const EXPECTED_POST: Record<string, string> = { off: 'off', ao: 'ao', aa: 'traa' };

/** True when data-post carries this exact token, so 'ssgi' does not match 'ssgi-half'. */
function hasPostToken(dataPost: string, token: string): boolean {
  expect(POST_TOKEN_ORDER, 'the token asked about is one data-post can carry').toContain(token);
  return dataPost.split(',').includes(token);
}

/**
 * The grid the two frames are reduced to before they are compared, and the tolerance a cell's
 * average channel has to exceed to count as changed, out of 255. Cells rather than raw pixels
 * because the resolution scaler decides each load's backing-store size from how heavy that load's
 * own frames were, and the AO load is the heavier one: measured on the webgl2 project's software
 * renderer, a pass-through frame rendered at 521x375 against the same frame at 948x683 moves
 * 0.2508 of its pixels purely by being upscaled to the same CSS box, which is more than the AO
 * moves. The same pair moves 0.0068 of its cells. The AO moves 0.2422 of them.
 */
const COMPARISON_CELLS = 32;
const CHANNEL_TOLERANCE = 4;
/** The share of changed cells the AO has to reach: 7 times the measured control, 5 times under it. */
const MIN_CHANGED_RATIO = 0.05;

/**
 * Opens a slice and returns the canvas once the chain has published what it turned on. The hard
 * wait is the delivery contract: a page whose data-post never appears is a page whose main.ts does
 * not wire the chain, and it fails here instead of skipping.
 */
async function openSlice(page: Page, slice: string): Promise<Locator> {
  // Retain normal onboarding while enabling the final diagnostic handle.
  await page.goto(`/?webgl=1&gate=off&e2e=1&onboarding=1&post=${slice}`);
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

  await expectPublishedPostState(canvas);

  await expect(canvas).toHaveAttribute('data-post', EXPECTED_POST[slice]);
  return canvas;
}

/** Reads the backing store after the shared idle/frame-delivery proof. */
async function settledBacking(page: Page): Promise<string> {
  await waitForLoopIdle(page);
  return page.evaluate(() => {
    const element = document.querySelector<HTMLCanvasElement>('canvas#scene')!;
    return `${element.width}x${element.height}`;
  });
}

/** Average red, green and blue of every cell of a cells x cells grid over the whole image. */
function cellMeans(png: PNG, cells: number): Float64Array {
  const totals = new Float64Array(cells * cells * 3);
  const counts = new Float64Array(cells * cells);
  for (let y = 0; y < png.height; y += 1) {
    const row = Math.min(cells - 1, Math.floor((y / png.height) * cells));
    for (let x = 0; x < png.width; x += 1) {
      const column = Math.min(cells - 1, Math.floor((x / png.width) * cells));
      const pixel = (y * png.width + x) * 4;
      const cell = (row * cells + column) * 3;
      totals[cell] += png.data[pixel];
      totals[cell + 1] += png.data[pixel + 1];
      totals[cell + 2] += png.data[pixel + 2];
      counts[row * cells + column] += 1;
    }
  }
  for (let cell = 0; cell < cells * cells; cell += 1) {
    totals[cell * 3] /= counts[cell];
    totals[cell * 3 + 1] /= counts[cell];
    totals[cell * 3 + 2] /= counts[cell];
  }
  return totals;
}

/**
 * The share of grid cells whose average red, green or blue differs by more than CHANNEL_TOLERANCE.
 * The two screenshots are of the same element and the same view, so they arrive at the same size
 * whatever each frame was rendered at, and a mismatch is a defect in the comparison itself.
 */
function changedCellRatio(before: Buffer, after: Buffer): number {
  const a = PNG.sync.read(before);
  const b = PNG.sync.read(after);
  expect(`${a.width}x${a.height}`, 'both frames at the same size').toBe(`${b.width}x${b.height}`);
  const left = cellMeans(a, COMPARISON_CELLS);
  const right = cellMeans(b, COMPARISON_CELLS);
  let changed = 0;
  for (let cell = 0; cell < COMPARISON_CELLS * COMPARISON_CELLS; cell += 1) {
    const dr = Math.abs(left[cell * 3] - right[cell * 3]);
    const dg = Math.abs(left[cell * 3 + 1] - right[cell * 3 + 1]);
    const db = Math.abs(left[cell * 3 + 2] - right[cell * 3 + 2]);
    if (Math.max(dr, dg, db) > CHANNEL_TOLERANCE) {
      changed += 1;
    }
  }
  return changed / (COMPARISON_CELLS * COMPARISON_CELLS);
}

test('ambient occlusion reaches the screen on webgl2', async ({ page }) => {
  // Two full loads in one test: the pass-through frame is the control the AO frame is measured
  // against, and a chain that silently fell back to pass-through would otherwise pass every
  // assertion in this file.
  test.setTimeout(120_000);

  const passThrough = await openSlice(page, 'off');
  const controlBacking = await settledBacking(page);
  const control = await passThrough.screenshot();

  const canvas = await openSlice(page, 'ao');
  const occludedBacking = await settledBacking(page);
  const occluded = await canvas.screenshot();

  expect(
    changedCellRatio(control, occluded),
    `cells the ambient occlusion moved against the pass-through frame ` +
      `(rendered at ${controlBacking} and ${occludedBacking})`,
  ).toBeGreaterThan(MIN_CHANGED_RATIO);

  const stats = await canvasStats(canvas);
  expect(stats.nonBackgroundRatio, 'share of the frame that is not the background').toBeGreaterThan(
    0.1,
  );
});

test('anti-aliasing reaches the screen on webgl2', async ({ page }) => {
  const canvas = await openSlice(page, 'aa');

  const stats = await canvasStats(canvas);
  expect(stats.nonBackgroundRatio, 'share of the frame that is not the background').toBeGreaterThan(
    0.1,
  );
});

test('max slice on webgl2 retains ao and traa without ssgi or ssr', async ({ page }) => {
  await page.goto('/?webgl=1&gate=off&post=max');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

  await expectPublishedPostState(canvas);

  const dataPost = (await canvas.getAttribute('data-post')) ?? '';
  expect(dataPost, 'data-post contains ao').toContain('ao');
  expect(dataPost, 'data-post contains traa').toContain('traa');
  expect(dataPost, 'data-post does not contain ssgi').not.toContain('ssgi');
  expect(dataPost, 'data-post does not contain ssr').not.toContain('ssr');
});

/**
 * Raw SSGI is kept as an explicit diagnostic slice. Its normal High preset is disabled because
 * its undenoised GI texture produced visible grain on the wall and garments at client resolution.
 * The WebGPU project defaults to headless and runs locally with the installed Chrome.
 */
test('normal WebGPU High stays free of raw SSGI', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgpu', 'High WebGPU preset only');
  await page.goto('/?e2e=1&tier=high&gate=off');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  await expect.poll(async () => {
    const post = (await canvas.getAttribute('data-post')) ?? '';
    return post.includes('traa') && post.includes('ssr') && !post.includes('ssgi');
  }).toBe(true);
});

test('diagnostic SSGI remains full resolution while the pointer drags on WebGPU', async ({ page }) => {
  test.skip(
    test.info().project.name !== 'webgpu',
    'SSGI exists on the WebGPU backend only; the webgl2 project publishes no ssgi token',
  );
  test.setTimeout(120_000);

  await page.goto('/?e2e=1&tier=high&gate=off&post=gi');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  // The explicit diagnostic slice publishes the full-resolution SSGI token.
  await expect
    .poll(async () => hasPostToken((await canvas.getAttribute('data-post')) ?? '', 'ssgi'), {
      timeout: POST_ATTRIBUTE_TIMEOUT,
      message: 'data-post carries the full-resolution ssgi token at rest',
    })
    .toBe(true);

  const box = await canvas.boundingBox();
  expect(box, 'the canvas has a box to drag inside').not.toBeNull();
  if (box === null) {
    return;
  }
  const originX = box.x + box.width / 2;
  const originY = box.y + box.height / 2;

  await expectDrawnDrag(page, canvas, originX, originY, ['ssgi'], ['ssgi-half'], ['ssgi-half']);

  await expect
    .poll(async () => hasPostToken((await canvas.getAttribute('data-post')) ?? '', 'ssgi'), {
      timeout: SSGI_RELEASE_TIMEOUT_MS,
      message: 'data-post carries the full-resolution ssgi token again after the release',
    })
    .toBe(true);
});

test('finishing pass reaches the screen on webgl2 on max and is absent on off', async ({ page }) => {
  await page.goto('/?webgl=1&gate=off&post=max');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

  await expectPublishedPostState(canvas);

  const dataPostMax = (await canvas.getAttribute('data-post')) ?? '';
  expect(dataPostMax, 'data-post on max contains lut').toContain('lut');
  expect(dataPostMax, 'data-post on max contains vignette').toContain('vignette');
  expect(dataPostMax, 'data-post on max contains bloom').toContain('bloom');
  expect(dataPostMax, 'data-post on max does not contain dof').not.toContain('dof');

  await page.goto('/?webgl=1&gate=off&post=off');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });

  await expectPublishedPostState(canvas);

  const dataPostOff = (await canvas.getAttribute('data-post')) ?? '';
  expect(dataPostOff, 'data-post on off does not contain lut').not.toContain('lut');
  expect(dataPostOff, 'data-post on off does not contain vignette').not.toContain('vignette');
  expect(dataPostOff, 'data-post on off does not contain bloom').not.toContain('bloom');
  expect(dataPostOff, 'data-post on off does not contain dof').not.toContain('dof');
});

test('depth of field follows camera rest and the walkthrough allowance on webgpu', async ({ page }) => {
  test.skip(
    test.info().project.name !== 'webgpu',
    'depth of field is available on the high WebGPU tier only',
  );
  test.setTimeout(120_000);

  await page.goto('/?e2e=1&post=finish&music=off');
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  await expect
    .poll(async () => hasPostToken((await canvas.getAttribute('data-post')) ?? '', 'dof'), {
      timeout: POST_ATTRIBUTE_TIMEOUT,
      message: 'depth of field turns on after the inspection camera rests',
    })
    .toBe(true);

  const walkButton = page.locator('button[data-mode="walk"]');
  await expect(walkButton).toBeEnabled({ timeout: POST_ATTRIBUTE_TIMEOUT });
  await page.evaluate(async () => window.archvizCamera?.setMode('walk'));
  await expect(canvas).toHaveAttribute('data-camera', 'walk');
  await expect
    .poll(async () => hasPostToken((await canvas.getAttribute('data-post')) ?? '', 'dof'))
    .toBe(false);

  await page.evaluate(async () => window.archvizCamera?.setMode('orbit'));
  await expect(canvas).toHaveAttribute('data-camera', 'orbit');
  await expect
    .poll(async () => hasPostToken((await canvas.getAttribute('data-post')) ?? '', 'dof'))
    .toBe(true);

  const box = await canvas.boundingBox();
  expect(box, 'the canvas has a box to drag inside').not.toBeNull();
  if (box === null) {
    return;
  }
  const originX = box.x + box.width / 2;
  const originY = box.y + box.height / 2;
  await expectDrawnDrag(page, canvas, originX, originY, [], ['dof']);

  await expect
    .poll(async () => hasPostToken((await canvas.getAttribute('data-post')) ?? '', 'dof'), {
      timeout: DOF_REST_TIMEOUT_MS,
      message: 'depth of field turns back on after the rest window',
    })
    .toBe(true);
});
