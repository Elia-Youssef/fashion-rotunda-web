import { expect, test } from '@playwright/test';
import type { APIRequestContext, ConsoleMessage, Locator, Page } from '@playwright/test';
import { canvasStats } from './support/pixels';
import { parseCatalog } from '../../src/catalog/catalog';
import type { Catalog } from '../../src/catalog/catalog';

// G1.7: the rotunda, the plinth and one look, loaded from public/content. The suite runs on the
// webgl2 project only. Nothing here is backend specific, the checks are about what the page loaded
// and what it freed, and the webgpu project opens a window on this machine that the memory run
// would hold open for minutes.

const SCENE_READY_TIMEOUT = 60_000;
/** Ten switches of the unoptimized set, 6 to 17 MB each, well past the 60 s default. */
const SWITCH_RUN_TIMEOUT = 240_000;
const SWITCHES = 10;

function skipUnlessWebgl2(): void {
  test.skip(test.info().project.name !== 'webgl2', 'the scene checks are backend independent');
}

/** The catalogue the page itself will load, read through the same server. */
async function readCatalog(request: APIRequestContext): Promise<Catalog> {
  const response = await request.get('/content/catalog.json');
  expect(response.ok(), 'public/content is on disk and served').toBeTruthy();
  const json: unknown = await response.json();
  return parseCatalog(json);
}

/** Opens the page and waits for the frame that has the look on the plinth. */
async function openScene(page: Page, path: string): Promise<Locator> {
  await page.goto(path);
  const canvas = page.locator('canvas#scene');
  await expect(canvas).toHaveAttribute('data-scene', 'ready', { timeout: SCENE_READY_TIMEOUT });
  return canvas;
}

test('shows the first look in the catalogue on its default variant', async ({ page, request }) => {
  skipUnlessWebgl2();
  const catalog = await readCatalog(request);
  const first = catalog.looks[0];

  const canvas = await openScene(page, '/?webgl=1');

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
  skipUnlessWebgl2();
  const catalog = await readCatalog(request);
  const zoot = catalog.looks.find((look) => look.id === 'zoot-suit');
  expect(zoot, 'the catalogue carries the zoot suit').toBeDefined();
  expect(zoot?.variants).toContain('dark');

  const canvas = await openScene(page, '/?webgl=1&look=zoot-suit&variant=dark');

  await expect(canvas).toHaveAttribute('data-look', 'zoot-suit');
  await expect(canvas).toHaveAttribute('data-variant', 'dark');
});

test('falls back to the defaults, with a warning, on a url that names neither', async ({
  page,
  request,
}) => {
  skipUnlessWebgl2();
  const catalog = await readCatalog(request);
  const first = catalog.looks[0];
  const warnings: ConsoleMessage[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().startsWith('[archviz]')) {
      warnings.push(message);
    }
  });

  const canvas = await openScene(page, '/?webgl=1&look=doublet&variant=chrome');

  await expect(canvas).toHaveAttribute('data-look', first.id);
  await expect(canvas).toHaveAttribute('data-variant', first.defaultVariant);
  expect(warnings.map((message) => message.text())).toEqual([
    expect.stringContaining('doublet'),
    expect.stringContaining('chrome'),
  ]);
});

test('builds the room from the material classes GLTFLoader creates', async ({ page }) => {
  skipUnlessWebgl2();
  await openScene(page, '/?webgl=1&e2e=1');

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

test('frees the look it replaces, so ten switches end where they started', async ({ page }) => {
  skipUnlessWebgl2();
  test.setTimeout(SWITCH_RUN_TIMEOUT);

  const canvas = await openScene(page, '/?webgl=1&e2e=1');
  const lookBefore = await canvas.getAttribute('data-look');
  // data-memory is renderer.info.memory as geometries/textures: live GPU resources, written after
  // every drawn frame. Both readings below are taken with the same look on the plinth.
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
