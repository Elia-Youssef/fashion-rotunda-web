// @vitest-environment jsdom
// detectSupport must answer with no GPU of any kind present: jsdom ships neither navigator.gpu
// nor a WebGL 2 context, which is exactly the baseline the no-poster path depends on.

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

afterEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: originalGetContext,
    writable: true,
    configurable: true,
  });
  Reflect.deleteProperty(window.navigator, 'gpu');
});

describe('detectSupport', () => {
  it('reports webgpu false when navigator.gpu is absent', () => {
    stubGetContext(null);
    expect(detectSupport(window)).toEqual({ webgpu: false, webgl2: false });
  });

  it('reports webgpu true when a gpu stub is present', () => {
    Object.defineProperty(window.navigator, 'gpu', { value: {}, configurable: true });
    stubGetContext(null);
    expect(detectSupport(window).webgpu).toBe(true);
  });

  it('reports webgl2 true when the probe context answers non-null', () => {
    stubGetContext({});
    expect(detectSupport(window)).toEqual({ webgpu: false, webgl2: true });
  });
});
