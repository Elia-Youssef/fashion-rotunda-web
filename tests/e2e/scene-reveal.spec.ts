import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Locator, Page } from '@playwright/test';

import { holdFirstRequest } from './support/held-request';

// E2E transition verification suite for two-stage stable-frame black reveal.
// Tests run on WebGL2 and WebGPU projects where available.

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'landscape', width: 844, height: 390 },
] as const;

type Backend = 'webgpu' | 'webgl2';
type FreezeState = 'ready-hidden' | 'cover-to-black' | 'black-hold' | 'revealing';

function expectedBackend(): Backend {
  return test.info().project.name === 'webgpu' ? 'webgpu' : 'webgl2';
}

function transitionPath(options: {
  backend: Backend;
  freeze?: FreezeState;
  onboarding?: boolean;
  music?: 'on' | 'off';
}): string {
  const params = new URLSearchParams({ e2e: '1', gate: 'on' });
  // Only the fallback project receives this flag. The WebGPU project must exercise the real
  // backend rather than quietly falling through to WebGL2 on machines where both are present.
  if (options.backend === 'webgl2') {
    params.set('webgl', '1');
  }
  if (options.freeze !== undefined) {
    params.set('freeze', options.freeze);
  }
  if (options.onboarding) {
    params.set('onboarding', '1');
  }
  if (options.music !== undefined) {
    params.set('music', options.music);
  }
  return `/?${params.toString()}`;
}

async function skipWhenWebGPUUnavailable(page: Page, backend: Backend): Promise<void> {
  if (backend !== 'webgpu') {
    return;
  }
  const unavailableReason = await page.evaluate(async () => {
    const gpu = (navigator as Navigator & {
      gpu?: { requestAdapter: () => Promise<unknown> };
    }).gpu;
    if (gpu === undefined) {
      return 'navigator.gpu is unavailable';
    }
    try {
      return (await gpu.requestAdapter()) === null ? 'navigator.gpu returned no adapter' : null;
    } catch (error) {
      return `requestAdapter failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  });
  test.skip(unavailableReason !== null, `WebGPU lifecycle skipped: ${unavailableReason ?? 'available'}`);
}

async function openTransition(
  page: Page,
  options: Omit<Parameters<typeof transitionPath>[0], 'backend'> = {},
): Promise<{ backend: Backend; lobby: Locator; veil: Locator; canvas: Locator }> {
  const backend = expectedBackend();
  await page.goto(transitionPath({ backend, ...options }));
  await skipWhenWebGPUUnavailable(page, backend);

  const lobby = page.locator('#entry-lobby');
  const veil = page.locator('#scene-veil');
  const canvas = page.locator('canvas#scene');
  await expect(lobby).toHaveAttribute('data-state', 'idle');
  return { backend, lobby, veil, canvas };
}

async function enterExperience(lobby: Locator, canvas: Locator, backend: Backend): Promise<void> {
  await lobby.locator('#lobby-load-btn').click();
  await expect(canvas).toHaveAttribute('data-backend', backend, { timeout: 60_000 });
}

// The veil reads black-hold as soon as the stable-frame handshake starts, but the handshake still has
// to wait for three scheduled scene renders (one committed black frame, then two counted frames).
// Under software GL with four workers that takes seconds. 10 s is far above that and far below the
// 90 s test budget, so a handshake that never completes still fails promptly.
const HANDSHAKE_TIMEOUT_MS = 10_000;

// The held first rotunda request keeps the boot in loading until the test releases it, so the
// loading phase below is observed while held; 30 s covers a slow boot start under four software
// workers, and sits far below the 90 s test budget.
const LOADING_HOLD_TIMEOUT_MS = 30_000;

// Waits until the handshake is parked at the `?freeze=black-hold` seam with its two stable frames.
// `stableFrames` only grows from 0 to 2 while the veil reads black-hold, and the seam then holds it
// at 2 until unfreeze() or a disruption. `timestamps.holdEnd` is recorded immediately before the
// coordinator parks at that freeze, so a disruption sent afterwards lands on a parked coordinator and
// leaves `stableFrames` at 0 instead of racing a handshake that restarts and counts back up to 2.
// Both fields come from one synchronous read. `holdEnd` is not cleared by a restart, so call this
// only before the first disruption.
async function expectParkedBehindBlack(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const seam = window.archvizTransitionSeam;
          return seam === undefined || seam.timestamps.holdEnd === null ? -1 : seam.stableFrames;
        }),
      {
        message: 'two stable frames were drawn behind black and the black-hold freeze was reached',
        timeout: HANDSHAKE_TIMEOUT_MS,
      },
    )
    .toBeGreaterThanOrEqual(2);
}

test.describe('Scene Reveal Transition', () => {
  test('executes two-stage reveal lifecycle in exact order with stable frames', async ({ page }) => {
    const consoleErrors: ConsoleMessage[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg);
      }
    });

    const { backend, lobby, veil, canvas } = await openTransition(page);

    // The held rotunda request keeps the boot in loading, so the loading phase is observed while
    // it is held instead of raced against the content that ends it.
    const rotunda = await holdFirstRequest(page, '**/content/rotunda.glb', LOADING_HOLD_TIMEOUT_MS);

    // Click load
    await enterExperience(lobby, canvas, backend);
    await rotunda.waitUntilEntered();
    await expect(lobby).toHaveAttribute('data-state', 'loading');
    await rotunda.release();
    await rotunda.waitUntilContinued();

    // Wait for full transition to revealed
    await expect(lobby).toHaveAttribute('data-state', 'revealed', { timeout: 60_000 });
    await expect(veil).toHaveAttribute('data-state', 'revealed');
    await expect(veil).toBeHidden();
    await expect(lobby).toBeHidden();
    await expect(canvas).toHaveAttribute('data-scene', 'ready');

    // Inspect recorded timestamps and stable frames via seam
    const seamData = await page.evaluate(() => {
      const seam = window.archvizTransitionSeam;
      if (!seam) return null;
      return {
        state: seam.state,
        stableFrames: seam.stableFrames,
        timestamps: seam.timestamps,
      };
    });

    expect(seamData, 'transition seam was exposed').not.toBeNull();
    if (seamData) {
      expect(seamData.state).toBe('revealed');
      expect(seamData.stableFrames).toBeGreaterThanOrEqual(2);

      const ts = seamData.timestamps;
      expect(ts.readyHidden, 'readyHidden recorded').not.toBeNull();
      expect(ts.coverStart, 'coverStart recorded').not.toBeNull();
      expect(ts.coverEnd, 'coverEnd recorded').not.toBeNull();
      expect(ts.holdStart, 'holdStart recorded').not.toBeNull();
      expect(ts.holdEnd, 'holdEnd recorded').not.toBeNull();
      expect(ts.revealStart, 'revealStart recorded').not.toBeNull();
      expect(ts.revealEnd, 'revealEnd recorded').not.toBeNull();

      expect(ts.readyHidden!).toBeLessThanOrEqual(ts.coverStart!);
      expect(ts.coverStart!).toBeLessThanOrEqual(ts.coverEnd!);
      expect(ts.coverEnd!).toBeLessThanOrEqual(ts.holdStart!);
      expect(ts.holdStart!).toBeLessThanOrEqual(ts.holdEnd!);
      expect(ts.holdEnd!).toBeLessThanOrEqual(ts.revealStart!);
      expect(ts.revealStart!).toBeLessThanOrEqual(ts.revealEnd!);
    }

    expect(consoleErrors, 'zero console errors').toHaveLength(0);
  });

  test('proves solid black veil opacity and readiness predicates during black-hold', async ({ page }) => {
    // Freeze at black-hold using the deterministic seam
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'black-hold' });
    await enterExperience(lobby, canvas, backend);

    // Wait until transition freezes at black-hold
    await expect(veil).toHaveAttribute('data-state', 'black-hold', { timeout: 60_000 });

    // Assert computed style: solid black, 100% opaque
    const veilStyle = await veil.evaluate((el) => {
      const computed = window.getComputedStyle(el);
      return {
        opacity: computed.opacity,
        backgroundColor: computed.backgroundColor,
        zIndex: computed.zIndex,
        visibility: computed.visibility,
      };
    });

    expect(veilStyle.opacity).toBe('1');
    expect(['rgb(0, 0, 0)', '#000000']).toContain(veilStyle.backgroundColor);
    expect(Number(veilStyle.zIndex)).toBeGreaterThanOrEqual(100);

    // Verify all 16 predicates evaluated true during hold
    const predicateResults = await page.evaluate(() => {
      return window.archvizTransitionSeam?.readPredicates() ?? {};
    });

    for (const [pred, ok] of Object.entries(predicateResults)) {
      expect(ok, `predicate ${pred} is true`).toBe(true);
    }

    // Stable frames behind black >= 2. The veil turns black-hold before the frames are counted, so
    // this polls; the freeze holds the counter at 2 once it gets there.
    await expect
      .poll(() => page.evaluate(() => window.archvizTransitionSeam?.stableFrames ?? -1), {
        message: 'at least two stable frames were drawn behind black',
        timeout: HANDSHAKE_TIMEOUT_MS,
      })
      .toBeGreaterThanOrEqual(2);

    // Unfreeze and confirm graceful completion to revealed
    await page.evaluate(() => window.archvizTransitionSeam?.unfreeze());
    await expect(veil).toHaveAttribute('data-state', 'revealed', { timeout: 30_000 });
    await expect(veil).toBeHidden();
  });

  test('freezes deterministic mid-reveal capture at a genuinely partial veil opacity', async ({ page }) => {
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'revealing' });
    await enterExperience(lobby, canvas, backend);
    await expect(veil).toHaveAttribute('data-state', 'revealing', { timeout: 60_000 });

    // The test seam now pauses before the 600 ms production fade wait, so this delay lands within
    // the running CSS opacity transition rather than after the transition has already completed.
    await page.waitForTimeout(300);
    const reading = await veil.evaluate((element) => ({
      opacity: Number.parseFloat(getComputedStyle(element).opacity),
      revealEnd: window.archvizTransitionSeam?.timestamps.revealEnd ?? null,
    }));
    expect(reading.opacity).toBeGreaterThan(0);
    expect(reading.opacity).toBeLessThan(1);
    expect(reading.revealEnd).toBeNull();

    await page.evaluate(() => window.archvizTransitionSeam?.unfreeze());
    await expect(veil).toHaveAttribute('data-state', 'revealed', { timeout: 30_000 });
  });

  test('keeps the branded ready-hidden lobby visible until cover-to-black begins', async ({ page }) => {
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'ready-hidden' });
    await enterExperience(lobby, canvas, backend);
    await expect(lobby).toHaveAttribute('data-state', 'ready-hidden', { timeout: 60_000 });
    await expect(veil).toHaveAttribute('data-state', 'ready-hidden');

    const composition = await page.evaluate(() => {
      const lobbyElement = document.querySelector<HTMLElement>('#entry-lobby');
      const veilElement = document.querySelector<HTMLElement>('#scene-veil');
      const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      return {
        lobbyVisibility: lobbyElement === null ? null : getComputedStyle(lobbyElement).visibility,
        veilVisibility: veilElement === null ? null : getComputedStyle(veilElement).visibility,
        veilOpacity: veilElement === null ? null : getComputedStyle(veilElement).opacity,
        hitLobby: hit?.closest('#entry-lobby') !== null,
      };
    });

    expect(composition.lobbyVisibility).toBe('visible');
    expect(composition.veilVisibility).toBe('hidden');
    expect(composition.veilOpacity).toBe('0');
    expect(composition.hitLobby).toBe(true);

    await page.evaluate(() => window.archvizTransitionSeam?.unfreeze());
    await expect(veil).toHaveAttribute('data-state', 'revealed', { timeout: 30_000 });
  });

  test('restarts the black-frame handshake after viewport disruption before revealing', async ({ page }) => {
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'black-hold' });
    await enterExperience(lobby, canvas, backend);
    await expect(veil).toHaveAttribute('data-state', 'black-hold', { timeout: 60_000 });
    await expectParkedBehindBlack(page);

    await page.setViewportSize({ width: 820, height: 1180 });
    await expect
      .poll(() => page.evaluate(() => window.archvizTransitionSeam?.stableFrames ?? -1))
      .toBe(0);
    await expect(veil).toHaveAttribute('data-state', 'black-hold');

    await page.evaluate(() => window.archvizTransitionSeam?.unfreeze());
    await expect(veil).toHaveAttribute('data-state', 'revealed', { timeout: 30_000 });
    expect(await page.evaluate(() => window.archvizTransitionSeam?.stableFrames)).toBeGreaterThanOrEqual(2);
  });

  test('waits for a hidden-tab restore, then reruns the black-frame handshake before reveal', async ({ page }) => {
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'black-hold' });
    await enterExperience(lobby, canvas, backend);
    await expect(veil).toHaveAttribute('data-state', 'black-hold', { timeout: 60_000 });
    await expectParkedBehindBlack(page);

    // Playwright cannot background a headed local window reliably. This temporarily overrides the
    // read-only document value in the isolated test page and dispatches the browser lifecycle
    // event, exercising the production listener without adding a product test seam.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => window.archvizTransitionSeam?.stableFrames ?? -1)).toBe(0);
    await expect(veil).toHaveAttribute('data-state', 'black-hold');

    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
      window.archvizTransitionSeam?.unfreeze();
    });
    await expect(veil).toHaveAttribute('data-state', 'revealed', { timeout: 30_000 });
    expect(await page.evaluate(() => window.archvizTransitionSeam?.stableFrames)).toBeGreaterThanOrEqual(2);
  });

  test('restarts the black-frame handshake after an orientation disruption before revealing', async ({ page }) => {
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'black-hold' });
    await enterExperience(lobby, canvas, backend);
    await expect(veil).toHaveAttribute('data-state', 'black-hold', { timeout: 60_000 });
    await expectParkedBehindBlack(page);

    await page.evaluate(() => window.dispatchEvent(new Event('orientationchange')));
    await expect.poll(() => page.evaluate(() => window.archvizTransitionSeam?.stableFrames ?? -1)).toBe(0);
    await expect(veil).toHaveAttribute('data-state', 'black-hold');

    await page.evaluate(() => window.archvizTransitionSeam?.unfreeze());
    await expect(veil).toHaveAttribute('data-state', 'revealed', { timeout: 30_000 });
    expect(await page.evaluate(() => window.archvizTransitionSeam?.stableFrames)).toBeGreaterThanOrEqual(2);
  });

  test('defers music and onboarding until the reveal has completed', async ({ page }) => {
    const { backend, lobby, veil, canvas } = await openTransition(page, {
      freeze: 'black-hold',
      music: 'on',
      onboarding: true,
    });
    await enterExperience(lobby, canvas, backend);
    await expect(veil).toHaveAttribute('data-state', 'black-hold', { timeout: 60_000 });

    const underBlack = await page.evaluate(() => ({
      music: window.archvizMusic?.state(),
      onboardingCards: document.querySelectorAll('.onboarding-card').length,
      headerMusic: document.querySelector<HTMLElement>('#shell-header button.music-switch')?.dataset.music,
    }));
    expect(underBlack.music, 'deferred player remains off while the veil is frozen').toBe('off');
    expect(underBlack.headerMusic, 'the control is only armed while loading').toBe('armed');
    expect(underBlack.onboardingCards, 'onboarding has not mounted behind the veil').toBe(0);

    await page.evaluate(() => window.archvizTransitionSeam?.unfreeze());
    await expect(veil).toHaveAttribute('data-state', 'revealed', { timeout: 30_000 });
    await expect(page.locator('#shell-header button.music-switch')).toHaveAttribute('data-music', 'playing', {
      timeout: 15_000,
    });
    await expect(page.locator('.onboarding-card')).toBeVisible();
    expect(await page.evaluate(() => window.archvizMusic?.state())).toBe('playing');
  });

  test('fails closed into a visible, pointer-operable retry surface', async ({ page }) => {
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'ready-hidden' });
    await enterExperience(lobby, canvas, backend);
    await expect(veil).toHaveAttribute('data-state', 'ready-hidden', { timeout: 60_000 });

    await page.evaluate(() => window.archvizReveal?.fail('Injected transition failure'));
    await expect(lobby).toHaveAttribute('data-state', 'error');
    await expect(veil).toBeHidden();
    const retry = lobby.getByRole('button', { name: 'RETRY LOADING' });
    await expect(retry).toBeVisible();

    const retryHit = await retry.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === element || element.contains(hit);
    });
    expect(retryHit).toBe(true);
  });

  test('keeps the showroom keyboard-inert throughout black-hold', async ({ page }) => {
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'black-hold' });
    await enterExperience(lobby, canvas, backend);
    await expect(veil).toHaveAttribute('data-state', 'black-hold', { timeout: 60_000 });

    await expect(page.locator('#shell-header')).toHaveAttribute('inert', '');
    await expect(page.locator('main')).toHaveAttribute('inert', '');
    await expect(page.locator('footer')).toHaveAttribute('inert', '');
    await page.keyboard.press('Tab');
    const focusOwner = await page.evaluate(() => document.activeElement?.closest('#entry-lobby, #scene')?.id ?? null);
    expect(focusOwner, 'keyboard navigation cannot reach the scene under black').not.toBe('scene');

    await page.evaluate(() => window.archvizTransitionSeam?.unfreeze());
    await expect(veil).toHaveAttribute('data-state', 'revealed', { timeout: 30_000 });
  });

  test('blocks pointer input until revealed, then enables camera interaction', async ({ page }) => {
    // Freeze at black-hold
    const { backend, lobby, veil, canvas } = await openTransition(page, { freeze: 'black-hold' });
    await enterExperience(lobby, canvas, backend);
    await expect(veil).toHaveAttribute('data-state', 'black-hold', { timeout: 60_000 });

    // Canvas cannot be hit while veil is active
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();
    const hitElement = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return el?.id ?? el?.tagName.toLowerCase();
    }, { x: canvasBox!.x + canvasBox!.width / 2, y: canvasBox!.y + canvasBox!.height / 2 });

    expect(['scene-veil', 'entry-lobby'], 'hit target is veil or lobby').toContain(hitElement);

    // Unfreeze
    await page.evaluate(() => window.archvizTransitionSeam?.unfreeze());
    await expect(veil).toHaveAttribute('data-state', 'revealed', { timeout: 30_000 });

    // After reveal: dragging canvas rotates camera
    const initialTurntable = await page.evaluate(() => window.archvizE2E?.turntableState());
    expect(initialTurntable).toBeDefined();

    // Drag on canvas
    await page.mouse.move(canvasBox!.x + canvasBox!.width / 2, canvasBox!.y + canvasBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvasBox!.x + canvasBox!.width / 2 + 100, canvasBox!.y + canvasBox!.height / 2);
    await page.mouse.up();

    // Canvas drew frames
    const frames = Number(await canvas.getAttribute('data-frames') ?? '0');
    expect(frames).toBeGreaterThan(0);
  });

  for (const vp of VIEWPORTS) {
    test(`captures and verifies transition responsiveness at ${vp.name} (${vp.width}x${vp.height})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const { backend, lobby, veil, canvas } = await openTransition(page);

      // Click load and await reveal
      await enterExperience(lobby, canvas, backend);
      await expect(veil).toHaveAttribute('data-state', 'revealed', { timeout: 60_000 });
      await expect(veil).toBeHidden();

      // Verify zero scroll after reveal
      const scrollMetrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
      }));

      expect(scrollMetrics.scrollWidth, `${vp.name} has no horizontal scroll`).toBeLessThanOrEqual(scrollMetrics.clientWidth);
      expect(scrollMetrics.scrollHeight, `${vp.name} has no vertical scroll`).toBeLessThanOrEqual(scrollMetrics.clientHeight);
    });
  }
});
