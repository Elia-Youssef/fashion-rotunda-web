import { expect, test } from './support/fixtures';
import { waitForLoopIdle, waitForSceneInitialization } from './support/ready';
import { nextProofReading, stableDrawCalls } from './support/preservation';
import { openShowroom } from './support/showroom';
import {
  SCENE_READY_TIMEOUT,
  STUDIO_LIGHTS,
  setNativeInput,
  expectRigAndUrl,
  expectDefaultRigWithoutUrl,
  proofDrawCalls,
} from './support/lightdrawer-helpers';

// Every case here reads serialized rig state, the light panel controls, or the draw-call census.
// None of that must precede the late chrome mount in src/main.ts: the rig and its URL parameter
// are runtime state, the panel assertions wait on their own elements, and the proof panel and the
// test handle are polled for directly. The shared opening also pins each page to its project's
// backend through the canvas data-backend attribute before any reading.
const DRAWER_PATH = '/?gate=off&e2e=1&proof=1&music=off';

test.describe('simplified Light Control drawer and rig', () => {

  test('warm and cool colors round-trip exactly for every studio light on each backend', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    await page.setViewportSize({ width: 1440, height: 900 });
    await openShowroom(page, request, DRAWER_PATH);

    const defaults = { key: '#ffffff', fill: '#ffffff', back: '#ffffff' };
    const colors = { ...defaults };
    const expectedRig = () =>
      `v2;key,1,15,${colors.key.slice(1)};fill,0,7,${colors.fill.slice(1)};back,0,7,${colors.back.slice(1)};day,0.5`;
    const panel = page.locator('#shell-light-panel');
    const toggle = page.locator('#shell-light-toggle');
    await toggle.click();
    await expect(panel).toBeVisible();
    await expectDefaultRigWithoutUrl(page, expectedRig());

    const assertPanelColors = async () => {
      for (const id of STUDIO_LIGHTS) {
        await expect(panel.locator(`[data-light="${id}"] .lightpanel__color`)).toHaveValue(colors[id]);
        await expect(panel.locator(`[data-light="${id}"] .lightpanel__value--color`)).toHaveText(
          colors[id],
        );
      }
    };
    const applyColor = async (id: (typeof STUDIO_LIGHTS)[number], color: string, label: string) => {
      const input = panel.locator(`[data-light="${id}"] .lightpanel__color`);
      const readout = panel.locator(`[data-light="${id}"] .lightpanel__value--color`);
      await setNativeInput(input, color);
      colors[id] = color;
      await expect(input, `${id} ${label} color input`).toHaveValue(color);
      await expect(readout, `${id} ${label} color readout`).toHaveText(color);
      await expectRigAndUrl(page, expectedRig());
    };

    for (const id of STUDIO_LIGHTS) await applyColor(id, '#ff9a3c', 'warm');
    const warmRig = expectedRig();
    await openShowroom(page, request, `${DRAWER_PATH}&rig=${encodeURIComponent(warmRig)}`);
    await expectRigAndUrl(page, warmRig);
    await page.locator('#shell-light-toggle').click();
    await expect(panel).toBeVisible();
    await assertPanelColors();

    for (const id of STUDIO_LIGHTS) await applyColor(id, '#3c9aff', 'cool');
    const coolRig = expectedRig();
    await openShowroom(page, request, `${DRAWER_PATH}&rig=${encodeURIComponent(coolRig)}`);
    await expectRigAndUrl(page, coolRig);
    await page.locator('#shell-light-toggle').click();
    await expect(panel).toBeVisible();
    await assertPanelColors();
    await expectRigAndUrl(page, expectedRig());
    await waitForLoopIdle(page);
  });

  test('daylight drag serializes coordinated exposure exactly on each backend', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    await page.setViewportSize({ width: 1440, height: 900 });
    await openShowroom(page, request, DRAWER_PATH);

    const panel = page.locator('#shell-light-panel');
    await page.locator('#shell-light-toggle').click();
    await expect(panel).toBeVisible();
    const daylight = panel.locator('.lightpanel__range--daylight');
    const readout = panel.locator('[data-light="daylight"] .lightpanel__value--daylight');

    await setNativeInput(daylight, '0.2');
    await expect(daylight).toHaveValue('0.2');
    await expect(readout).toHaveText('Dawn');
    await expectRigAndUrl(
      page,
      'v2;key,1,15,ffffff;fill,0,7,ffffff;back,0,7,ffffff;day,0.2;e,1.06',
    );

    await setNativeInput(daylight, '0.85');
    await expect(daylight).toHaveValue('0.85');
    await expect(readout).toHaveText('Noon');
    await expectRigAndUrl(
      page,
      'v2;key,1,15,ffffff;fill,0,7,ffffff;back,0,7,ffffff;day,0.85;e,0.93',
    );
    await waitForLoopIdle(page);
  });

  test('three-point states and intensity endpoints retain one draw-call census on each backend', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);

    await page.setViewportSize({ width: 1440, height: 900 });
    const { canvas } = await openShowroom(page, request, DRAWER_PATH);

    const enabled = { key: true, fill: false, back: false };
    const intensities = { key: 15, fill: 7, back: 7 };
    const expectedRig = () =>
      `v2;key,${enabled.key ? 1 : 0},${intensities.key},ffffff;fill,${enabled.fill ? 1 : 0},${intensities.fill},ffffff;back,${enabled.back ? 1 : 0},${intensities.back},ffffff;day,0.5`;

    await expectDefaultRigWithoutUrl(page, expectedRig());
    await waitForSceneInitialization(page, SCENE_READY_TIMEOUT);
    // The panel may still show an empty warm-up frame. Compare two actual refreshes after
    // initialization, including scale/post, rather than polling the same stale text twice.
    let previous = await nextProofReading(page);
    let baselineDrawCalls: number | null = null;
    await expect.poll(async () => {
      const current = await nextProofReading(page);
      baselineDrawCalls = stableDrawCalls(previous, current);
      previous = current;
      return baselineDrawCalls;
    }, { timeout: 30_000 }).not.toBeNull();
    if (baselineDrawCalls === null) throw new Error('missing Key-only draw-call baseline');

    const panel = page.locator('#shell-light-panel');
    await page.locator('#shell-light-toggle').click();
    await expect(panel).toBeVisible();
    const toggle = (id: (typeof STUDIO_LIGHTS)[number]) =>
      panel.locator(`[data-light="${id}"] .lightpanel__switch`);

    await toggle('fill').click();
    enabled.fill = true;
    await expectRigAndUrl(page, expectedRig());

    await toggle('fill').click();
    enabled.fill = false;
    await toggle('back').click();
    enabled.back = true;
    await expectRigAndUrl(page, expectedRig());

    await toggle('fill').click();
    enabled.fill = true;
    await expectRigAndUrl(page, expectedRig());
    await expect.poll(() => proofDrawCalls(page), { timeout: 30_000 }).toBe(baselineDrawCalls);

    for (const id of STUDIO_LIGHTS) {
      const range = panel.locator(`[data-light="${id}"] .lightpanel__range`);
      const readout = panel.locator(`[data-light="${id}"] .lightpanel__value--intensity`);
      await setNativeInput(range, '0');
      intensities[id] = 0;
      await expect(range, `${id} minimum intensity input`).toHaveValue('0');
      await expect(readout, `${id} minimum intensity readout`).toHaveText('0.0 cd');
      await expectRigAndUrl(page, expectedRig());
      await expect(canvas).toHaveAttribute('data-scene', 'ready');
      await expect.poll(() => proofDrawCalls(page), { timeout: 30_000 }).toBeGreaterThan(0);

      await setNativeInput(range, '50');
      intensities[id] = 50;
      await expect(range, `${id} maximum intensity input`).toHaveValue('50');
      await expect(readout, `${id} maximum intensity readout`).toHaveText('50.0 cd');
      await expectRigAndUrl(page, expectedRig());
      await expect(canvas).toHaveAttribute('data-scene', 'ready');
      await expect.poll(() => proofDrawCalls(page), { timeout: 30_000 }).toBeGreaterThan(0);
    }

    for (const id of STUDIO_LIGHTS) {
      await setNativeInput(panel.locator(`[data-light="${id}"] .lightpanel__range`), String(id === 'key' ? 15 : 7));
      intensities[id] = id === 'key' ? 15 : 7;
    }
    await toggle('fill').click();
    enabled.fill = false;
    await toggle('back').click();
    enabled.back = false;
    await expectDefaultRigWithoutUrl(page, expectedRig());
    await waitForLoopIdle(page);
  });

  test('WebGPU smoke opens the drawer and updates serialized rig when available', async ({
    page,
    request,
  }) => {
    test.skip(test.info().project.name !== 'webgpu', 'WebGPU smoke belongs to the WebGPU project');

    await page.setViewportSize({ width: 1440, height: 900 });
    await openShowroom(page, request, DRAWER_PATH);
    await page.locator('#shell-light-toggle').click();
    const key = page.locator('[data-light="key"] .lightpanel__switch');
    // `data-scene=ready` is published by the first drawn content frame. On the actual WebGPU
    // path, shader compilation and final test-handle mounting can still follow it, so wait for
    // the handle rather than treating that transient null as the pre-toggle rig state.
    await expect
      .poll(() => page.evaluate(() => window.archvizE2E?.rigState() ?? null), { timeout: 30_000 })
      .toMatch(/^v2;/);
    const before = await page.evaluate(() => window.archvizE2E?.rigState() ?? null);
    await key.click();
    await expect.poll(() => page.evaluate(() => window.archvizE2E?.rigState() ?? null)).not.toBe(before);
  });
});
