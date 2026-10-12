// @vitest-environment jsdom
// detectSupport must answer with no GPU of any kind present: jsdom ships neither navigator.gpu
// nor a WebGL 2 context. Presence alone is not support either: the probes answer only when
// WebGPU returns a live adapter and WebGL 2 returns a live context, which is exactly what a
// browser with its graphics APIs disabled looks like.

import { afterEach, describe, expect, it } from 'vitest';

import { detectSupport } from '../../src/renderer/support';

const originalGetContext = HTMLCanvasElement.prototype.getContext;

// getContext is heavily overloaded, so a value swap through defineProperty sidesteps both the
// overload resolution a spy would fight and the jsdom "Not implemented" console noise the real
// method would print on a 'webgl2' request.
function stubGetContext(context: unknown): void {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => context,
    writable: true,
    configurable: true,
  });
}

function stubThrowingGetContext(): void {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: (): WebGL2RenderingContext => {
      throw new Error('context creation refused');
    },
    writable: true,
    configurable: true,
  });
}

function stubGpu(requestAdapter: () => Promise<unknown>): void {
  Object.defineProperty(window.navigator, 'gpu', {
    value: { requestAdapter },
    configurable: true,
  });
}

afterEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: originalGetContext,
    writable: true,
    configurable: true,
  });
  Reflect.deleteProperty(window.navigator, 'gpu');
});

describe('detectSupport', () => {
  it('reports no support when neither API is present', async () => {
    stubGetContext(null);
    await expect(detectSupport(window)).resolves.toEqual({ webgpu: false, webgl2: false });
  });

  it('counts WebGPU only when an adapter answers: null means it cannot start', async () => {
    stubGpu(async () => null);
    stubGetContext(null);
    await expect(detectSupport(window)).resolves.toEqual({ webgpu: false, webgl2: false });
  });

  it('counts WebGPU when the adapter request resolves with an adapter', async () => {
    stubGpu(async () => ({ info: { vendor: 'stub' } }));
    stubGetContext(null);
    await expect(detectSupport(window)).resolves.toEqual({ webgpu: true, webgl2: false });
  });

  it('treats a throwing adapter request as no WebGPU support', async () => {
    stubGpu(async () => {
      throw new Error('adapter enumeration failed');
    });
    stubGetContext(null);
    await expect(detectSupport(window)).resolves.toEqual({ webgpu: false, webgl2: false });
  });

  it('treats a gpu property without a callable requestAdapter as no WebGPU support', async () => {
    Object.defineProperty(window.navigator, 'gpu', { value: {}, configurable: true });
    stubGetContext(null);
    await expect(detectSupport(window)).resolves.toEqual({ webgpu: false, webgl2: false });
  });

  it('reports webgl2 true when the probe context answers non-null', async () => {
    stubGetContext({});
    await expect(detectSupport(window)).resolves.toEqual({ webgpu: false, webgl2: true });
  });

  it('treats a throwing context probe as no WebGL 2 support', async () => {
    stubThrowingGetContext();
    await expect(detectSupport(window)).resolves.toEqual({ webgpu: false, webgl2: false });
  });
});
