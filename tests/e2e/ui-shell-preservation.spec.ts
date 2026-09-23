import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

// UI12-AUDIT-06: opening a purely presentational shell disclosure must not reset or otherwise
// perturb renderer state. This lives apart from the layout suite because it is deliberately about
// the runtime handles and drawing buffer, not the disclosure's geometry.

const SCENE_READY_TIMEOUT = 60_000;
const IDLE_TIMEOUT_ATTEMPTS = 12;

interface SceneSignature {
  meshes: number;
  materials: Record<string, number>;
}

interface RendererState {
  camera: {
    mode: string | null;
    position: number[];
    target: number[];
  };
  canvas: {
    cssWidth: number;
    cssHeight: number;
    backingWidth: number;
    backingHeight: number;
    devicePixelRatio: number;
    scaleX: number;
    scaleY: number;
    backend: string | null;
    post: string | null;
  };
  look: string | null;
  variant: string | null;
  memory: string | null;
  scene: SceneSignature;
  frames: number;
}

function skipUnlessWebgl2(): void {
  test.skip(test.info().project.name !== 'webgl2', 'runs headless against the WebGL 2 fallback');
}

async function readRendererState(page: Page): Promise<RendererState> {
  return await page.evaluate((): RendererState => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas#scene');
    const camera = window.archvizCamera;
    const hooks = window.archvizE2E;
    if (canvas === null || camera === undefined || hooks === undefined) {
      throw new Error('the e2e canvas, camera, or scene handle is unavailable');
    }
    const rect = canvas.getBoundingClientRect();
    const description = hooks.describeScene();
    return {
      camera: {
        mode: camera.mode,
        position: [...camera.orbit.position],
        target: [...camera.orbit.target],
      },
      canvas: {
        cssWidth: rect.width,
        cssHeight: rect.height,
        backingWidth: canvas.width,
        backingHeight: canvas.height,
        devicePixelRatio: window.devicePixelRatio,
        scaleX: canvas.width / (rect.width * window.devicePixelRatio),
        scaleY: canvas.height / (rect.height * window.devicePixelRatio),
        backend: canvas.dataset.backend ?? null,
        post: canvas.dataset.post ?? null,
      },
      look: canvas.dataset.look ?? null,
      variant: canvas.dataset.variant ?? null,
      memory: canvas.dataset.memory ?? null,
      // renderer.info draw-call counts are frame-local, whereas this is an actual hierarchy
      // signature and remains meaningful once the demand loop is asleep.
      scene: { meshes: description.meshes, materials: description.materials },
      frames: Number(canvas.dataset.frames ?? '0'),
    };
  });
}

/** Two equal readings a second apart establish that the demand loop has gone back to sleep. */
async function waitForLoopIdle(canvas: Locator, page: Page): Promise<number> {
  let previous = Number(await canvas.getAttribute('data-frames'));
  for (let attempt = 0; attempt < IDLE_TIMEOUT_ATTEMPTS; attempt += 1) {
    await page.waitForTimeout(1000);
    const current = Number(await canvas.getAttribute('data-frames'));
    if (current > 0 && current === previous) {
      return current;
    }
    previous = current;
  }
  throw new Error(`the render loop did not become idle within ${IDLE_TIMEOUT_ATTEMPTS} seconds`);
}

test('opening and closing Light Control preserves renderer state and returns to idle', async ({
  page,
}) => {
  skipUnlessWebgl2();
  test.setTimeout(120_000);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?webgl=1&gate=off&e2e=1');
  const canvas = page.locator('canvas#scene');
  const toggle = page.locator('#shell-light-toggle');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // A non-default inspection pose makes a silent Reset-camera side effect observable.
  await page.evaluate(() => {
    const camera = window.archvizCamera;
    if (camera === undefined) {
      throw new Error('the e2e camera handle is unavailable');
    }
    camera.orbit.setPose([1.5, 2.0, 3.0], [0, 1.2, 0], 40);
  });
  await waitForLoopIdle(canvas, page);
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

  const idleFrames = await waitForLoopIdle(canvas, page);
  const after = await readRendererState(page);
  expect(after.frames, 'the reported idle frame count agrees with the canvas').toBe(idleFrames);

  // Exact deep equality intentionally covers mode, pose, active look, scene topology, post choice,
  // backing dimensions, and derived render scale. A shell-only change may schedule frames, but it
  // must not change any persistent renderer state.
  expect(after).toEqual({ ...before, frames: after.frames });

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
