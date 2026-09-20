// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureStill, deliverStill } from '../../src/share/screenshot';
import type { ScreenshotOptions } from '../../src/share/screenshot';

type NavigatorKey = 'share' | 'canShare';

/**
 * jsdom's navigator carries neither share nor canShare, so a test that defines one has to take it
 * away again: left behind, it tells every later test in this file that the page can share.
 */
const savedDescriptors = new Map<NavigatorKey, PropertyDescriptor | undefined>();

function stubNavigator(key: NavigatorKey, value: unknown): void {
  if (!savedDescriptors.has(key)) {
    savedDescriptors.set(key, Object.getOwnPropertyDescriptor(navigator, key));
  }
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
}

describe('share screenshot module', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, descriptor] of savedDescriptors) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(navigator, key);
      } else {
        Object.defineProperty(navigator, key, descriptor);
      }
    }
    savedDescriptors.clear();
  });

  it('captureStill scales pixel ratio, draws frame, calls toBlob, and restores ratio', async () => {
    let currentPixelRatio = 1.5;
    const renderer = {
      getPixelRatio: vi.fn(() => currentPixelRatio),
      setPixelRatio: vi.fn((val: number) => {
        currentPixelRatio = val;
      }),
    };
    const drawFrame = vi.fn();
    const mockBlob = new Blob(['png-bytes'], { type: 'image/png' });
    const canvas = document.createElement('canvas');
    canvas.toBlob = vi.fn((callback: BlobCallback) => {
      callback(mockBlob);
    });

    const options: ScreenshotOptions = {
      renderer,
      canvas,
      drawFrame,
      scale: 2,
    };

    const blob = await captureStill(options);
    expect(blob).toBe(mockBlob);
    expect(renderer.setPixelRatio).toHaveBeenNthCalledWith(1, 3.0);
    expect(drawFrame).toHaveBeenCalledTimes(1);
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
    expect(renderer.setPixelRatio).toHaveBeenNthCalledWith(2, 1.5);
  });

  it('captureStill puts the pixel ratio back when the draw throws', () => {
    let currentPixelRatio = 1.25;
    const renderer = {
      getPixelRatio: vi.fn(() => currentPixelRatio),
      setPixelRatio: vi.fn((val: number) => {
        currentPixelRatio = val;
      }),
    };
    const canvas = document.createElement('canvas');
    canvas.toBlob = vi.fn();

    expect(() =>
      captureStill({
        renderer,
        canvas,
        drawFrame: () => {
          throw new Error('device lost mid capture');
        },
        scale: 2,
      }),
    ).toThrow('device lost mid capture');
    // Without the restore the page would draw four times the pixels for the rest of the visit.
    expect(currentPixelRatio).toBe(1.25);
    expect(canvas.toBlob).not.toHaveBeenCalled();
  });

  it('captureStill reads the canvas before it puts the ratio back', async () => {
    const ratios: number[] = [];
    let currentPixelRatio = 1;
    const renderer = {
      getPixelRatio: (): number => currentPixelRatio,
      setPixelRatio: (val: number): void => {
        currentPixelRatio = val;
      },
    };
    const canvas = document.createElement('canvas');
    canvas.toBlob = vi.fn((callback: BlobCallback) => {
      // The ratio the read happens at is the whole point of the capture.
      ratios.push(currentPixelRatio);
      callback(new Blob(['png-bytes'], { type: 'image/png' }));
    });

    await captureStill({ renderer, canvas, drawFrame: () => undefined, scale: 2 });
    expect(ratios).toEqual([2]);
    expect(currentPixelRatio).toBe(1);
  });

  it('deliverStill downloads via temporary object URL when share is unsupported', async () => {
    vi.useFakeTimers();
    const mockBlob = new Blob(['data'], { type: 'image/png' });
    const createObjectURLSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:http://localhost/test');
    const revokeObjectURLSpy = vi
      .spyOn(URL, 'revokeObjectURL')
      .mockImplementation(() => undefined);

    // jsdom navigates on a real anchor click, which it then reports as an unimplemented feature.
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    const resultPromise = deliverStill(mockBlob, 'fashion-rotunda-look-01-20260920-120000.png');
    const result = await resultPromise;
    expect(result).toBe('downloaded');
    expect(createObjectURLSpy).toHaveBeenCalledWith(mockBlob);
    expect(clickSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://localhost/test');
    vi.useRealTimers();
  });

  it('deliverStill shares via navigator.share when supported', async () => {
    const mockBlob = new Blob(['data'], { type: 'image/png' });
    const shareMock = vi.fn().mockResolvedValue(undefined);
    const canShareMock = vi.fn().mockReturnValue(true);

    stubNavigator('share', shareMock);
    stubNavigator('canShare', canShareMock);

    const result = await deliverStill(mockBlob, 'fashion-rotunda-look-01-20260920-120000.png');
    expect(result).toBe('shared');
    expect(canShareMock).toHaveBeenCalledTimes(1);
    expect(shareMock).toHaveBeenCalledTimes(1);
  });

  it('deliverStill downloads the still when the visitor dismisses the share sheet', async () => {
    const mockBlob = new Blob(['data'], { type: 'image/png' });
    const dismissed = new Error('Share canceled');
    dismissed.name = 'AbortError';
    stubNavigator('share', vi.fn().mockRejectedValue(dismissed));
    stubNavigator('canShare', vi.fn().mockReturnValue(true));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://localhost/test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await deliverStill(mockBlob, 'fashion-rotunda-look-01-20260920-120000.png');
    // 'shared' here would tell the visitor the still left the page when nothing did.
    expect(result).toBe('downloaded');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    // A dismissal is a choice, not a fault, so it is not worth a console line.
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
