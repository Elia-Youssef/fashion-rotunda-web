import { expect, test, browserReports } from './support/fixtures';
import { waitForSceneInitialization } from './support/ready';
import { canvasStats } from './support/pixels';
import { openShowroom } from './support/showroom';

// Every case here checks what the page loaded and how it holds its state: the look and variant on
// the plinth, the url contract, the fallback warnings, the material classes GLTFLoader created and
// the GPU memory a replaced look releases. None of that changes with the renderer backend, so
// every case runs on both projects, each opened through the shared showroom helper, whose
// canvas[data-backend] pin keeps a silent fallback from pointing a run at the wrong renderer.

/** The budget for the initialization wait that follows the shared opening. */
const SCENE_INITIALIZATION_TIMEOUT = 60_000;
/** Ten switches of the unoptimized set, 6 to 17 MB each, well past the 60 s default. */
const SWITCH_RUN_TIMEOUT = 240_000;
const SWITCHES = 10;

test('shows the first look in the catalogue on its default variant', async ({ page, request }) => {
  const { canvas, catalog } = await openShowroom(page, request, '/?gate=off');
  const first = catalog.looks[0];

  await expect(canvas).toHaveAttribute('data-look', first.id);
  await expect(canvas).toHaveAttribute('data-variant', first.defaultVariant);

  // The room fills the frame from the proof camera, so a canvas that is almost all one colour
  // means the scene never arrived even though the attribute says it did.
  const stats = await canvasStats(canvas);
  expect(stats.nonBackgroundRatio, 'share of the frame that is not the background').toBeGreaterThan(
    0.1,
  );
});

test('takes the look and the variant from the url', async ({ page, request }) => {
  const { canvas, catalog } = await openShowroom(
    page,
    request,
    '/?gate=off&look=zoot-suit&variant=dark',
  );
  const zoot = catalog.looks.find((look) => look.id === 'zoot-suit');
  expect(zoot, 'the catalogue carries the zoot suit').toBeDefined();
  expect(zoot?.variants).toContain('dark');

  await expect(canvas).toHaveAttribute('data-look', 'zoot-suit');
  await expect(canvas).toHaveAttribute('data-variant', 'dark');
});

test('falls back to the defaults, with a warning, on a url that names neither', async ({
  page,
  request,
}) => {
  const { canvas, catalog } = await openShowroom(
    page,
    request,
    '/?gate=off&look=doublet&variant=chrome',
  );
  const first = catalog.looks[0];

  await expect(canvas).toHaveAttribute('data-look', first.id);
  await expect(canvas).toHaveAttribute('data-variant', first.defaultVariant);
  expect(browserReports(page).filter((message) => message.type === 'warning' &&
    message.text.startsWith('[archviz]')).map((message) => message.text)).toEqual([
    expect.stringContaining('doublet'),
    expect.stringContaining('chrome'),
  ]);
});

test('builds the room from the material classes GLTFLoader creates', async ({ page, request }) => {
  await openShowroom(page, request, '/?e2e=1');
  await waitForSceneInitialization(page, SCENE_INITIALIZATION_TIMEOUT);

  const description = await page.evaluate(() => {
    const hooks = window.archvizE2E;
    if (hooks === undefined) {
      throw new Error('the e2e hook is missing');
    }
    return hooks.describeScene();
  });

  // The marble and the brass arrive as MeshStandardMaterial; the dome glass and anything carrying
  // clearcoat, ior or specular arrives as MeshPhysicalMaterial. Both render on WebGPURenderer.
  expect(Object.keys(description.materials)).toContain('MeshStandardMaterial');
  expect(Object.keys(description.materials)).toContain('MeshPhysicalMaterial');
  expect(description.meshes, 'meshes in the scene').toBeGreaterThan(20);
  expect(description.drawCalls, 'draw calls in the last frame').toBeGreaterThan(0);
  expect(description.triangles, 'triangles in the last frame').toBeGreaterThan(0);
});

test('frees the look it replaces on both backends', async ({ page, request }) => {
  test.setTimeout(SWITCH_RUN_TIMEOUT);

  // The shared opening pins canvas[data-backend] to the project's own backend, so a silent
  // fallback cannot make the run read the wrong renderer before any reading is taken.
  const { canvas } = await openShowroom(page, request, '/?e2e=1');
  await waitForSceneInitialization(page, SCENE_INITIALIZATION_TIMEOUT);
  const lookBefore = await canvas.getAttribute('data-look');
  // data-memory is renderer.info.memory as geometries/textures: live GPU resources, written after
  // every drawn frame. Both readings are taken with the same look on the plinth, so ten switches
  // that free what they replace end where they started, and a look whose GPU resources were never
  // released ends above its start. The count covers the renderer's resources only. The CPU-side
  // bulk of a look, the geometry attribute arrays and the compressed image bytes, lives outside
  // them, and the browser's JavaScript heap numbers exclude those buffers as external memory, so
  // no heap reading available to this page can see a look the page still references. That the
  // JavaScript graph itself is released is pinned by the look-owner unit tests.
  const memoryBefore = await canvas.getAttribute('data-memory');
  expect(memoryBefore, 'the memory reading is published').not.toBeNull();

  expect(await page.evaluate(() => typeof window.archvizE2E), 'the e2e hook is mounted').toBe(
    'object',
  );
  await page.evaluate(async (count: number) => {
    const hooks = window.archvizE2E;
    if (hooks === undefined) {
      throw new Error('the e2e hook is missing');
    }
    await hooks.switchLooks(count);
  }, SWITCHES);

  await expect(canvas).toHaveAttribute('data-look', String(lookBefore));
  expect(await canvas.getAttribute('data-memory'), 'geometries/textures after ten switches').toBe(
    memoryBefore,
  );
});
