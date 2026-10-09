import { expect, test, type ConsoleMessage } from '@playwright/test';

// Opaque entry lobby on a real load.
// WebGL2 project runs headless, ensuring deterministic test execution.
test('gates the experience until the visitor activates Load Experience', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgl2', 'runs headless, where no pointer can enter the gate');
  const messages: ConsoleMessage[] = [];
  page.on('console', (message) => messages.push(message));
  // The default sky is generated in memory: the page must never fetch the diagnostic HDR, and the
  // bar reaching 1 below proves the byte total does not wait for it either.
  const hdrRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('.hdr')) hdrRequests.push(request.url());
  });

  // Delay the rotunda slightly so the in-flight loading state is observable
  await page.route('**/content/rotunda.glb', async (route) => {
    await page.waitForTimeout(1000);
    await route.continue();
  });

  await page.goto('/?webgl=1');
  const lobby = page.locator('#entry-lobby');
  const canvas = page.locator('canvas#scene');

  // 1. Initial idle state: lobby is fully mounted and opaque, no content loading has begun
  await expect(lobby).toHaveCount(1);
  await expect(lobby).toHaveAttribute('data-state', 'idle');
  await expect(lobby).toHaveAttribute('role', 'dialog');
  expect(await canvas.getAttribute('data-scene'), 'scene has not started').toBeNull();

  const loadButton = lobby.locator('#lobby-load-btn');
  await expect(loadButton).toBeEnabled();

  // 2. Click "Load Experience" to start loading
  await loadButton.click();

  // 3. Immediately transitions to loading state
  await expect(lobby).toHaveAttribute('data-state', 'loading');
  await expect(loadButton).toBeDisabled();
  await expect(lobby.locator('.entry-lobby__loading-pane')).toBeVisible();

  // 4. Progress bar reaches completion
  const readProgress = async (): Promise<number> =>
    Number((await lobby.locator('progress').getAttribute('value')) ?? '0');
  await expect
    .poll(readProgress, { message: 'the bar reaches the end of the load', timeout: 60_000 })
    .toBe(1);

  // 5. Transitions through ready-hidden, black veil, to revealed
  await expect(lobby).toHaveAttribute('data-state', 'revealed', { timeout: 60_000 });
  await expect(canvas).toHaveAttribute('data-scene', 'ready');

  // Lobby and scene-veil are hidden once revealed
  await expect(lobby).toBeHidden();
  const veil = page.locator('#scene-veil');
  await expect(veil).toHaveAttribute('data-state', 'revealed');
  await expect(veil).toBeHidden();

  // Shell elements are interactive
  await expect(page.locator('#shell-header')).not.toHaveAttribute('inert');
  await expect(page.locator('main')).not.toHaveAttribute('inert');

  // Deferred audio starts once revealed
  await expect(page.locator('#shell-header button.music-switch')).toHaveAttribute('data-music', 'playing', {
    timeout: 15_000,
  });

  const errors = messages.filter((message) => message.type() === 'error');
  expect(errors, 'no console messages of type error').toHaveLength(0);
  expect(hdrRequests, 'the default sky requests no .hdr file').toHaveLength(0);
});

// ?sky=hdr: the School Field HDR diagnostic is fetched exactly once and counted in the byte total,
// so the bar still reaches the end.
test('counts and fetches the HDR once under the ?sky=hdr diagnostic', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgl2', 'runs headless, where no pointer can enter the gate');
  const hdrRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('.hdr')) hdrRequests.push(request.url());
  });

  await page.goto('/?webgl=1&sky=hdr');
  const lobby = page.locator('#entry-lobby');
  await lobby.locator('#lobby-load-btn').click();
  await expect
    .poll(async () => Number((await lobby.locator('progress').getAttribute('value')) ?? '0'), {
      message: 'the bar reaches the end of the load, HDR included',
      timeout: 60_000,
    })
    .toBe(1);
  await expect(lobby).toHaveAttribute('data-state', 'revealed', { timeout: 60_000 });
  expect(hdrRequests).toHaveLength(1);
  expect(new URL(hdrRequests[0]).pathname).toBe('/content/env/school-field-cloudy-1k.hdr');
});

// Keyboard Enter activation on the focused Load button
test('activates Load Experience on Enter from the keyboard', async ({ page }) => {
  test.skip(test.info().project.name !== 'webgl2', 'runs headless, where no pointer can enter the gate');

  await page.goto('/?webgl=1');
  const lobby = page.locator('#entry-lobby');
  const loadButton = lobby.locator('#lobby-load-btn');

  await expect(lobby).toHaveAttribute('data-state', 'idle');
  await expect(loadButton).toBeFocused();

  await loadButton.press('Enter');
  await expect(lobby).toHaveAttribute('data-state', 'loading');
  await expect(lobby).toHaveAttribute('data-state', 'revealed', { timeout: 60_000 });
  await expect(page.locator('canvas#scene')).toHaveAttribute('data-scene', 'ready');
  await expect(lobby).toBeHidden();
});

// Explicit bypass URLs: gate=off and e2e=1 (without gate=on)
for (const search of ['?webgl=1&gate=off', '?webgl=1&e2e=1']) {
  test(`bypasses the lobby on ${search}`, async ({ page }) => {
    test.skip(test.info().project.name !== 'webgl2', 'the headed project would play through the speakers');

    await page.goto(`/${search}`);
    await expect(page.locator('canvas#scene')).toHaveAttribute('data-scene', /loading|ready|error/, {
      timeout: 30_000,
    });
    await expect(page.locator('#entry-lobby')).toHaveCount(0);
  });
}
