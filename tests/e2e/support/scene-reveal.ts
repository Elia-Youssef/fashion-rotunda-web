import { expect, test } from './fixtures';
import type { Locator, Page } from '@playwright/test';

import { SCENE_READY_TIMEOUT } from './ready';
import { backendPath, projectBackend } from './backend';

// E2E transition verification suite for two-stage stable-frame black reveal.
// Tests run on WebGL2 and WebGPU projects where available.

export const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'landscape', width: 844, height: 390 },
] as const;

type Backend = 'webgpu' | 'webgl2';
type FreezeState = 'ready-hidden' | 'cover-to-black' | 'black-hold' | 'revealing';

function transitionPath(options: {
  freeze?: FreezeState;
  onboarding?: boolean;
  music?: 'on' | 'off';
}): string {
  const params = new URLSearchParams({ e2e: '1', gate: 'on' });
  if (options.freeze !== undefined) {
    params.set('freeze', options.freeze);
  }
  if (options.onboarding) {
    params.set('onboarding', '1');
  }
  if (options.music !== undefined) {
    params.set('music', options.music);
  }
  return backendPath(`/?${params.toString()}`);
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

export async function openTransition(
  page: Page,
  options: Parameters<typeof transitionPath>[0] = {},
): Promise<{ backend: Backend; lobby: Locator; veil: Locator; canvas: Locator }> {
  const backend = projectBackend();
  await page.goto(transitionPath(options));
  await skipWhenWebGPUUnavailable(page, backend);

  const lobby = page.locator('#entry-lobby');
  const veil = page.locator('#scene-veil');
  const canvas = page.locator('canvas#scene');
  await expect(lobby).toHaveAttribute('data-state', 'idle');
  return { backend, lobby, veil, canvas };
}

export async function enterExperience(lobby: Locator, canvas: Locator, backend: Backend): Promise<void> {
  await lobby.locator('#lobby-load-btn').click();
  await expect(canvas).toHaveAttribute('data-backend', backend, { timeout: SCENE_READY_TIMEOUT });
}

export async function expectRevealComplete(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.archvizReveal?.state), { timeout: SCENE_READY_TIMEOUT }).toBe('revealed');
  await expect(page.locator('#scene-veil')).toHaveCount(0);
  expect(await page.evaluate(() => window.archvizTransitionSeam === undefined)).toBe(true);
}

// The veil reads black-hold as soon as the stable-frame handshake starts, but the handshake still has
// to wait for three scheduled scene renders (one committed black frame, then two counted frames).
// Under software GL with four workers that takes seconds. 10 s is far above that and far below the
// 90 s test budget, so a handshake that never completes still fails promptly.
export const HANDSHAKE_TIMEOUT_MS = 10_000;
