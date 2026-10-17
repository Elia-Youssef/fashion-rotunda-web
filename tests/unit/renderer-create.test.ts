// Node environment on purpose: the pure pieces of createRenderer (the loss shapes, the handler
// chain, the error line) are covered without constructing a renderer, and the WebGL 2 GPU badge
// runs createRenderer against a module double, so nothing here needs a GPU.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRenderer, describeRendererError, installLossHandlers, normaliseLoss } from '../../src/renderer/create';
import type {
  DeviceLostInfo,
  RendererLossReport,
  RendererOptions,
} from '../../src/renderer/create';

// The WebGL 2 half of the GPU badge: readWebGlRendererName is reached only through
// createRenderer, so its cases run the factory with the renderer double below and a live
// stand-in context. The double keeps this suite independent of the factory suite's harness.
const webglName = vi.hoisted(() => {
  const state: { context: unknown } = { context: null };
  class RendererDouble {
    backend = { isWebGPUBackend: false };
    toneMapping = 0;
    getContext = () => state.context;
    init(): Promise<void> {
      return Promise.resolve();
    }
    setPixelRatio(): void {}
    dispose(): void {}
    onDeviceLost(): void {}
    onError(): void {}
  }
  return { RendererDouble, state };
});

vi.mock('three/webgpu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three/webgpu')>();
  return { ...actual, WebGPURenderer: webglName.RendererDouble };
});

describe('normaliseLoss', () => {
  it('keeps the reason and message the WebGPU backend reports', () => {
    // Shape built by WebGPUBackend.js lines 270-275 from the device.lost info.
    const webgpuReport = {
      api: 'WebGPU',
      message: 'GPU reset',
      reason: 'device-collision',
      originalEvent: { reason: 'device-collision', message: 'GPU reset' },
    };

    expect(normaliseLoss('webgpu', webgpuReport)).toEqual({
      backend: 'webgpu',
      reason: 'device-collision',
      message: 'GPU reset',
    });
  });

  it('maps the WebGL report, whose reason is always null, to unknown', () => {
    // Shape built by WebGLBackend.js lines 236-241 from the webglcontextlost event.
    const webglReport = {
      api: 'WebGL',
      message: 'Unknown reason',
      reason: null,
      originalEvent: { statusMessage: '' },
    };

    expect(normaliseLoss('webgl2', webglReport)).toEqual({
      backend: 'webgl2',
      reason: 'unknown',
      message: 'Unknown reason',
    });
  });

  it('falls back to the documented defaults when the renderer reports nothing', () => {
    expect(normaliseLoss('webgpu', undefined)).toEqual({
      backend: 'webgpu',
      reason: 'unknown',
      message: '',
    });
  });

  it('ignores reason and message fields that are not non-empty strings', () => {
    expect(normaliseLoss('webgl2', { reason: 7, message: [] })).toEqual({
      backend: 'webgl2',
      reason: 'unknown',
      message: '',
    });
    expect(normaliseLoss('webgpu', null)).toEqual({
      backend: 'webgpu',
      reason: 'unknown',
      message: '',
    });
  });
});

/**
 * A stand-in for the renderer's two callback slots. The default device-lost handler mirrors three.js:
 * a method that writes `this._isDeviceLost` (Renderer.js line 1360). Calling it bare throws, which is
 * why the device-lost flag is the assertion that matters below.
 */
function fakeRenderer() {
  const reports: RendererLossReport[] = [];
  const errors: string[] = [];
  const fake = {
    _isDeviceLost: false,
    onDeviceLost(info: RendererLossReport): void {
      reports.push(info);
      this._isDeviceLost = true;
    },
    onError(errorMessage: string): void {
      errors.push(errorMessage);
    },
  };
  return { fake, reports, errors };
}

describe('installLossHandlers', () => {
  it('calls the WebGPU handler directly: the default runs as a method, the caller gets the info', () => {
    const { fake, reports } = fakeRenderer();
    const seen: DeviceLostInfo[] = [];
    installLossHandlers(fake, 'webgpu', { onDeviceLost: (info) => seen.push(info) });

    // The shape WebGPUBackend.js lines 270-275 build from device.lost; a real device.destroy() reports
    // reason 'destroyed', which three.js ignores before this handler, so the call is made by hand.
    fake.onDeviceLost({
      api: 'WebGPU',
      message: 'GPU reset',
      reason: 'device-collision',
      originalEvent: { reason: 'device-collision', message: 'GPU reset' },
    });

    expect(fake._isDeviceLost).toBe(true);
    expect(reports).toHaveLength(1);
    expect(reports[0].api).toBe('WebGPU');
    expect(reports[0].reason).toBe('device-collision');
    expect(seen).toEqual([{ backend: 'webgpu', reason: 'device-collision', message: 'GPU reset' }]);
  });

  it('hands the WebGL report to the default with reason null and still stops the renderer', () => {
    const { fake, reports } = fakeRenderer();
    const seen: DeviceLostInfo[] = [];
    installLossHandlers(fake, 'webgl2', { onDeviceLost: (info) => seen.push(info) });

    fake.onDeviceLost({ api: 'WebGL', message: 'Unknown reason', reason: null, originalEvent: {} });

    expect(fake._isDeviceLost).toBe(true);
    expect(reports[0].reason).toBeNull();
    expect(seen).toEqual([{ backend: 'webgl2', reason: 'unknown', message: 'Unknown reason' }]);
  });

  it('routes uncaptured errors to the caller instead of the default logger', () => {
    const { fake, errors } = fakeRenderer();
    const seen: unknown[] = [];
    installLossHandlers(fake, 'webgpu', { onError: (error) => seen.push(error) });

    fake.onError('validation failed');

    expect(errors).toHaveLength(0);
    expect(seen).toEqual(['validation failed']);
  });

  it('works without caller handlers and restores both defaults', () => {
    const { fake, reports, errors } = fakeRenderer();
    const originalOnDeviceLost = fake.onDeviceLost;
    const originalOnError = fake.onError;
    const restore = installLossHandlers(fake, 'webgpu', {});

    fake.onDeviceLost({ api: 'WebGPU', message: 'lost', reason: 'unknown', originalEvent: undefined });
    fake.onError('ignored');
    expect(fake._isDeviceLost).toBe(true);
    expect(reports).toHaveLength(1);
    expect(errors).toHaveLength(0);

    restore();
    expect(fake.onDeviceLost).toBe(originalOnDeviceLost);
    expect(fake.onError).toBe(originalOnError);
  });

  it('supports the trackTimestamp option in RendererOptions', () => {
    const options: Pick<RendererOptions, 'pixelRatioCap' | 'trackTimestamp'> = {
      pixelRatioCap: 2,
      trackTimestamp: true,
    };
    expect(options.trackTimestamp).toBe(true);
  });
});

describe('createRenderer on the WebGL 2 backend: the GPU badge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    webglName.state.context = null;
  });

  // A context stand-in that passes the instanceof check against the stubbed global and answers
  // the WEBGL_debug_renderer_info dance exactly as a live context does.
  function liveContext(extension: unknown, reported: unknown): object {
    const contextType = class {};
    vi.stubGlobal('WebGL2RenderingContext', contextType);
    const context = Object.create(contextType.prototype) as {
      getExtension: () => unknown;
      getParameter: () => unknown;
    };
    context.getExtension = () => extension;
    context.getParameter = () => reported;
    return context;
  }

  async function badgeName(context: unknown): Promise<string> {
    webglName.state.context = context;
    vi.stubGlobal('window', { devicePixelRatio: 1 });
    const handle = await createRenderer({
      canvas: { dataset: {} } as HTMLCanvasElement,
      pixelRatioCap: 2,
      forceWebGL: true,
    });
    expect(handle.backend).toBe('webgl2');
    return handle.gpuName;
  }

  it('reports the unmasked renderer string a live context exposes', async () => {
    const name = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_1 ps_5_1)';
    const reported = await badgeName(liveContext({ UNMASKED_RENDERER_WEBGL: 0x9246 }, name));
    expect(reported).toBe(name);
  });

  it('keeps unknown when the browser masks the debug extension', async () => {
    await expect(badgeName(liveContext(null, 'irrelevant'))).resolves.toBe('unknown');
  });

  it('keeps unknown when the extension lacks the constant or it is not a number', async () => {
    await expect(badgeName(liveContext({}, 'irrelevant'))).resolves.toBe('unknown');
    await expect(
      badgeName(liveContext({ UNMASKED_RENDERER_WEBGL: 'not-a-number' }, 'irrelevant')),
    ).resolves.toBe('unknown');
  });

  it('keeps unknown when the reported renderer is empty or not a string', async () => {
    const constant = 0x9246;
    await expect(badgeName(liveContext({ UNMASKED_RENDERER_WEBGL: constant }, ''))).resolves.toBe('unknown');
    await expect(badgeName(liveContext({ UNMASKED_RENDERER_WEBGL: constant }, 4090))).resolves.toBe('unknown');
  });
});

describe('describeRendererError', () => {
  it('keeps the whole WebGPU message, prefixed with the api and the error type', () => {
    // Shape built by WebGPUBackend.js lines 287-292 from an uncapturederror event.
    const message = 'Texture copy range (origin: [Origin3D x:0, y:0, z:0]) touches outside of [Texture] - While finishing [CommandEncoder "renderContext_7"].';
    const report = { api: 'WebGPU', type: 'GPUValidationError', message, originalEvent: {} };
    expect(describeRendererError(report)).toBe(`WebGPU GPUValidationError: ${message}`);
  });

  it('falls back to the bare message when api and type are missing', () => {
    expect(describeRendererError(new Error('shader compile failed'))).toBe('shader compile failed');
  });

  it('stringifies anything without a text message', () => {
    expect(describeRendererError('lost')).toBe('lost');
    expect(describeRendererError(null)).toBe('null');
    expect(describeRendererError({ message: 42 })).toBe('[object Object]');
  });
});
