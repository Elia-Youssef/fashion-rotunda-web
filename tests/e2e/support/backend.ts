import type { Page } from '@playwright/test';

import { expect, test } from './fixtures';

/** The renderer backend each configured project is expected to exercise. */
export function projectBackend(): 'webgpu' | 'webgl2' {
  return test.info().project.name === 'webgpu' ? 'webgpu' : 'webgl2';
}

/** Force the fallback only in its project; native WebGPU fixtures must not carry webgl=1. */
export function backendPath(path: string): string {
  const url = new URL(path, 'http://localhost');
  if (projectBackend() === 'webgl2') {
    url.searchParams.set('webgl', '1');
  } else {
    url.searchParams.delete('webgl');
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Fail, never skip, a webgpu-project case whose page cannot reach WebGPU: a missing navigator.gpu,
 * a null adapter or a failed requestAdapter means the run is broken, and a skipped case would let
 * that broken run pass as green. The webgl2 project needs no WebGPU, so there this returns at once.
 * navigator.gpu is exposed only in secure contexts, and the browser's start page (about:blank) is
 * not one, so call this after the goto, with the page under test.
 */
export async function requireWebGPU(page: Page): Promise<void> {
  if (projectBackend() !== 'webgpu') {
    return;
  }
  const failure = await page.evaluate(async () => {
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
  expect(failure, 'the webgpu project is broken without a working WebGPU adapter').toBe(null);
}
