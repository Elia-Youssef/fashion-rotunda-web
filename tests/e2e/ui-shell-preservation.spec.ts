import { expect, test } from './support/fixtures';
import { waitForLoopIdle, waitForSceneInitialization } from './support/ready';
import { assertRendererPreserved, nextProofReading } from './support/preservation';
import type { Page } from '@playwright/test';

// UI12-AUDIT-06: opening a purely presentational shell disclosure must not reset or otherwise
// perturb renderer state. This lives apart from the layout suite because it is deliberately about
// the runtime handles and drawing buffer, not the disclosure's geometry.

const SCENE_READY_TIMEOUT = 60_000;

type RendererState = Omit<Awaited<ReturnType<typeof nextProofReading>>, 'drawCalls'>;

function skipUnlessWebgl2(): void {
  test.skip(
    test.info().project.name !== 'webgl2',
    'the shared shell-preservation contract runs once on the WebGL 2 fallback',
  );
}

async function readRendererState(page: Page): Promise<RendererState> {
  const { drawCalls, ...state } = await nextProofReading(page);
  void drawCalls;
  return state;
}

test('opening and closing Light Control preserves renderer state and returns to idle', async ({
  page,
}) => {
  skipUnlessWebgl2();
  test.setTimeout(120_000);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?webgl=1&gate=off&e2e=1&proof=1');
  const canvas = page.locator('canvas#scene');
  const toggle = page.locator('#shell-light-toggle');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);

  // A non-default inspection pose makes a silent Reset-camera side effect observable.
  await page.evaluate(() => {
    const camera = window.archvizCamera;
    if (camera === undefined) {
      throw new Error('the e2e camera handle is unavailable');
    }
    camera.orbit.setPose([1.5, 2.0, 3.0], [0, 1.2, 0], 40);
  });
  await waitForLoopIdle(page);
  const before = await readRendererState(page);
  expect(before.camera.mode, 'the preservation fixture begins in inspection mode').toBe('orbit');
  for (const [axis, wanted] of [1.5, 2, 3].entries()) {
    expect(
      before.camera.position[axis],
      'the preservation fixture used the requested non-default pose',
    ).toBeCloseTo(wanted, 12);
  }
  expect(before.canvas.post, 'the renderer publishes its active post state').not.toBeNull();
  expect(before.memory, 'the renderer publishes its live resource count').not.toBeNull();

  const openingStarted = Date.now();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const openResponseMs = Date.now() - openingStarted;

  const closingStarted = Date.now();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const closeResponseMs = Date.now() - closingStarted;

  // Record current-runtime latency as evidence, but do not apply a wall-clock threshold here:
  // Playwright's click and ARIA assertions already fail a stuck disclosure, while multi-worker
  // scheduling makes elapsed host time unsuitable as a deterministic rendering-performance gate.

  await expect
    .poll(async () => Number(await canvas.getAttribute('data-frames')), {
      message: 'the two real interactions wake the demand loop',
      timeout: 5_000,
    })
    .toBeGreaterThan(before.frames);
  const immediatelyAfter = await readRendererState(page);

  const idleFrames = await waitForLoopIdle(page);
  const after = await readRendererState(page);
  expect(after.frames, 'the reported idle frame count agrees with the canvas').toBe(idleFrames);

  // Camera, look, scene topology, live resource counts and post remain exact. Only a
  // backing-size change explained by the independently published scaler is permitted.
  assertRendererPreserved(before, immediatelyAfter, 'after interactions');
  assertRendererPreserved(before, after, 'after idle');

  await test.info().attach('shell-light-preservation-runtime.json', {
    body: JSON.stringify(
      {
        openResponseMs,
        closeResponseMs,
        interactionFrames: immediatelyAfter.frames - before.frames,
        idleFrames,
        canvas: after.canvas,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});
