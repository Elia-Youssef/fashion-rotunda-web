// Node environment on purpose: normaliseLoss and installLossHandlers are the pure pieces of
// createRenderer, so the loss shapes and the handler chain are covered without constructing a
// WebGPURenderer, which jsdom could not back with a GPU.

import { describe, expect, it } from 'vitest';

import { installLossHandlers, normaliseLoss } from '../../src/renderer/create';
import type {
  DeviceLostInfo,
  RendererLossReport,
  RendererOptions,
} from '../../src/renderer/create';

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
 * exactly the defect the G0.3 audit found, so the flag is the assertion that matters below.
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
