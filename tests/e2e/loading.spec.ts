import { expect, test, type ConsoleMessage } from '@playwright/test';

// G6.5: the entry gate on a real load, without e2e=1, so the gate is exactly what a visitor gets.
// The webgl2 project only, the pattern of tests/e2e/idle.spec.ts: the webgpu project runs headed,
// where a stray pointer over the window would tap Enter mid-load and end the gate early.
test('gates the page until the visitor taps Enter', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgl2', 'runs headless, where no pointer can enter the gate');
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => messages.push(message));

  // The preview server hands over the whole 11.5 MB faster than one evaluate round trip, so the
  // bar would jump from 0 to 1 invisibly; holding the rotunda back a moment makes the per-file
  // step observable without touching the page. Before the goto: the GLB requests start while the
  // module runs, inside the goto.
  await page.route('**/content/rotunda.glb', async (route) => {
    await page.waitForTimeout(1500);
    await route.continue();
  });

  await page.goto('/?webgl=1');
  const gate = page.locator('.loading-gate');
  const canvas = page.locator('canvas#scene');

  // The gate is up before the room is: still in its loading state while the canvas has not
  // reported ready. The content set is 11.5 MB, so the moment right after goto is safely mid-load.
  await expect(gate).toHaveCount(1);
  expect(await canvas.getAttribute('data-scene'), 'the room is still loading').not.toBe('ready');
  await expect(gate).toHaveAttribute('data-gate', 'loading');
  await expect(gate).toHaveAttribute('role', 'dialog');
  const button = gate.locator('button');
  await expect(button).toBeDisabled();

  // The bar moves per file: Resource Timing reports a file only once it has fully arrived. On the
  // preview server all three first-frame GLBs can land before the first read, so a bar caught
  // mid-way is not observable here; what is asserted is that it reaches the end of the load.
  // The value IDL property reflects into the content attribute, which reads without a cast.
  const readProgress = async (): Promise<number> =>
    Number((await gate.locator('progress').getAttribute('value')) ?? '0');
  await expect
    .poll(readProgress, { message: 'the bar reaches the end of the load', timeout: 60_000 })
    .toBe(1);

  // The scene, the shader compile and the reveal all happen behind the gate; 60 s covers the
  // full content set at a slow pace, the same budget the smoke suite gives data-scene.
  await expect(gate).toHaveAttribute('data-gate', 'ready', { timeout: 60_000 });
  await expect(button).toBeEnabled();

  await button.click();
  await expect(gate).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-scene', 'ready');

  // The tap is the gesture the music waits for: src/audio/mount.ts listens on window with
  // capture: true, and the gate stops no event on its way there. 15 s is music.spec.ts's budget
  // for the first loop to decode and start.
  await expect(page.locator('header button.music-switch')).toHaveAttribute('data-music', 'playing', {
    timeout: 15_000,
  });

  const errors = messages.filter((message) => message.type() === 'error');
  expect(errors, 'no console messages of type error').toHaveLength(0);
});

// The keyboard half of the same door. A separate load because the tap above already consumed the
// gate, and Enter on a focused native button is a different code path in the browser than a click.
test('enters on Enter from the keyboard', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgl2', 'runs headless, where no pointer can enter the gate');

  await page.goto('/?webgl=1');
  const gate = page.locator('.loading-gate');
  const button = gate.locator('button');
  // No route delay here, so the load is the plain one; 45 s leaves room inside the 60 s test.
  await expect(gate).toHaveAttribute('data-gate', 'ready', { timeout: 45_000 });
  // ready() focuses the button itself, so Enter needs no click first: that is the whole point.
  await expect(button).toBeFocused();
  await button.press('Enter');
  await expect(gate).toHaveCount(0);
  await expect(page.locator('canvas#scene')).toHaveAttribute('data-scene', 'ready');
});

// The two URLs that turn the gate off. Both wait for data-scene first, which main.ts writes after
// the mount point, so an absent gate is an answer and not a race with the page's own boot.
for (const search of ['?webgl=1&gate=off', '?webgl=1&e2e=1']) {
  test(`mounts no gate on ${search}`, async ({ page }) => {
    test.skip(test.info().project.name !== 'webgl2', 'the headed project would play through the speakers');

    await page.goto(`/${search}`);
    await expect(page.locator('canvas#scene')).toHaveAttribute('data-scene', /loading|ready|error/, {
      timeout: 30_000,
    });
    await expect(page.locator('.loading-gate')).toHaveCount(0);
  });
}
