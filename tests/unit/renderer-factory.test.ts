import { AgXToneMapping, WebGPURenderer } from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRenderer } from '../../src/renderer/create';
import type { RendererLossReport, RendererOptions } from '../../src/renderer/create';

const double = vi.hoisted(() => {
  const events: string[] = [];
  const state = { initialWebGPU: true, finalWebGPU: true };
  class RendererDouble {
    backend = { isWebGPUBackend: state.initialWebGPU };
    toneMapping = 0;
    lost = false;
    lossReports: RendererLossReport[] = [];
    defaultErrors: unknown[] = [];
    originalOnDeviceLost = this.onDeviceLost;
    originalOnError = this.onError;
    callbacksAtDispose: unknown[] = [];
    init = vi.fn(async () => {
      events.push('init');
      this.backend = { isWebGPUBackend: state.finalWebGPU };
    });
    setPixelRatio = vi.fn();
    getContext = vi.fn(() => null);
    dispose = vi.fn(() => {
      this.callbacksAtDispose = [this.onDeviceLost, this.onError];
    });
    onDeviceLost(report: RendererLossReport): void {
      this.lost = true;
      this.lossReports.push(report);
    }
    onError(error: unknown): void {
      this.defaultErrors.push(error);
    }
  }
  const instances: RendererDouble[] = [];
  const construct = vi.fn(function () {
    events.push('construct');
    const renderer = new RendererDouble();
    instances.push(renderer);
    return renderer;
  });
  const separate = vi.fn(() => { events.push('separate'); });
  return { events, state, instances, construct, separate };
});

vi.mock('three/webgpu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three/webgpu')>();
  return { ...actual, WebGPURenderer: double.construct };
});
vi.mock('../../src/renderer/viewport-texture', () => ({
  separateViewportTextureSizes: double.separate,
}));

// Node supplies only the DOM properties this factory reads; neither context stub starts a GPU.
function options(overrides: Partial<RendererOptions> = {}): RendererOptions {
  const canvas = { dataset: {} } as HTMLCanvasElement;
  return { canvas, pixelRatioCap: 2, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  double.events.length = 0;
  double.instances.length = 0;
  double.state.initialWebGPU = true;
  double.state.finalWebGPU = true;
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('WebGL2RenderingContext', class {});
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('createRenderer', () => {
  it.each([undefined, false, true])('passes canvas, antialias and forceWebGL=%s to construction',
    async (forceWebGL) => {
      const input = options(forceWebGL === undefined ? {} : { forceWebGL });
      const handle = await createRenderer(input);
      expect(WebGPURenderer).toHaveBeenCalledExactlyOnceWith({
        canvas: input.canvas, antialias: true, forceWebGL: forceWebGL === true,
      });
      expect(handle.renderer).toBe(double.instances[0]);
    });

  it.each([false, true])('passes explicit trackTimestamp=%s', async (trackTimestamp) => {
    const input = options({ trackTimestamp });
    await createRenderer(input);
    expect(WebGPURenderer).toHaveBeenCalledExactlyOnceWith({
      canvas: input.canvas, antialias: true, forceWebGL: false, trackTimestamp,
    });
  });

  it('separates viewport textures before construction and initialisation', async () => {
    await createRenderer(options());
    expect(double.separate).toHaveBeenCalledTimes(1);
    expect(double.events).toEqual(['separate', 'construct', 'init']);
  });

  it.each([
    { device: 3, cap: 2, expected: 2 },
    { device: 1.25, cap: 2, expected: 1.25 },
    { device: 2, cap: 2, expected: 2 },
  ])('sets pixel ratio $expected for device $device and cap $cap', async ({ device, cap, expected }) => {
    vi.stubGlobal('window', { devicePixelRatio: device });
    await createRenderer(options({ pixelRatioCap: cap }));
    expect(double.instances[0].setPixelRatio).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it('sets AgX tone mapping', async () => {
    await createRenderer(options());
    expect(double.instances[0].toneMapping).toBe(AgXToneMapping);
  });

  it.each([
    { initial: false, final: true, backend: 'webgpu' },
    { initial: true, final: false, backend: 'webgl2' },
  ])('reads $backend after init replaces the backend', async ({ initial, final, backend }) => {
    double.state.initialWebGPU = initial;
    double.state.finalWebGPU = final;
    const input = options();
    const handle = await createRenderer(input);
    expect(double.instances[0].init).toHaveBeenCalledTimes(1);
    expect(handle.backend).toBe(backend);
    expect(input.canvas.dataset.backend).toBe(backend);
    expect(handle.gpuName).toBe('unknown');
  });

  it('reads the WebGPU adapter name after initialisation', async () => {
    const requestAdapter = vi.fn(async () => {
      expect(double.events).toEqual(['separate', 'construct', 'init']);
      return { info: { vendor: 'Vendor', architecture: '', device: 'Device', description: 'GPU' } };
    });
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    const handle = await createRenderer(options());
    expect(handle.gpuName).toBe('Vendor Device GPU');
    expect(requestAdapter).toHaveBeenCalledTimes(1);
    expect(double.instances[0].getContext).not.toHaveBeenCalled();
  });

  it.each(['missing', 'empty', 'rejected'])('keeps startup working with a %s adapter name',
    async (kind) => {
      const requestAdapter = vi.fn(async () => {
        if (kind === 'rejected') throw new Error('enumeration failed');
        return kind === 'missing' ? null :
          { info: { vendor: '', architecture: '', device: '', description: '' } };
      });
      vi.stubGlobal('navigator', { gpu: { requestAdapter } });
      expect((await createRenderer(options())).gpuName).toBe('unknown');
    });

  it.each(['webgpu', 'webgl2'] as const)('wires loss and error reporting for %s', async (backend) => {
    double.state.finalWebGPU = backend === 'webgpu';
    const onDeviceLost = vi.fn();
    const onError = vi.fn();
    await createRenderer(options({ onDeviceLost, onError }));
    const renderer = double.instances[0];
    const report: RendererLossReport = {
      api: backend === 'webgpu' ? 'WebGPU' : 'WebGL',
      reason: 'reset', message: 'context reset', originalEvent: null,
    };
    renderer.onDeviceLost(report);
    renderer.onError('validation failed');
    expect(renderer.lost).toBe(true);
    expect(renderer.lossReports).toHaveLength(1);
    expect(onDeviceLost).toHaveBeenCalledExactlyOnceWith({
      backend, reason: 'reset', message: 'context reset',
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith('validation failed');
    expect(renderer.defaultErrors).toEqual([]);
  });

  it('restores both callbacks before disposing the renderer', async () => {
    const handle = await createRenderer(options());
    const renderer = double.instances[0];
    expect(renderer.onDeviceLost).not.toBe(renderer.originalOnDeviceLost);
    expect(renderer.onError).not.toBe(renderer.originalOnError);
    handle.dispose();
    expect(renderer.callbacksAtDispose).toEqual([
      renderer.originalOnDeviceLost, renderer.originalOnError,
    ]);
    expect(renderer.onDeviceLost).toBe(renderer.originalOnDeviceLost);
    expect(renderer.onError).toBe(renderer.originalOnError);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });
});
