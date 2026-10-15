// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RIG } from '../../src/lighting/rig';
import { DEFAULT_RIG_SERIALIZED } from '../../src/share/state';
import type { ShareMount, ShareMountOptions } from '../../src/share/mount';
import type { ShareActions } from '../../src/ui/share';
import { TIERS } from '../../src/tiers/table';

let imports = 0;
let actions: ShareActions;
let handle: ShareMount | null = null;
const capture = vi.fn(async () => new Blob(['still']));
const deliver = vi.fn(async () => 'saved');
const notify = vi.fn();
// Doubling a fractional drawing-buffer size can differ by one pixel after independent flooring.
const FLOOR_TOLERANCE_PX = 1;
beforeEach(() => {
  vi.resetModules();
  imports = 0;
  vi.clearAllMocks();
  vi.doMock('../../src/share/screenshot', () => {
    imports += 1;
    return { captureStill: capture, deliverStill: deliver };
  });
  vi.doMock('../../src/ui/share', () => ({
    mountShare: (_root: HTMLElement, next: ShareActions) => {
      actions = next;
      return { notify, dispose: vi.fn() };
    },
  }));
});
afterEach(() => {
  handle?.dispose();
  handle = null;
  vi.doUnmock('../../src/share/screenshot');
  vi.doUnmock('../../src/ui/share');
});

async function mount(): Promise<ShareMountOptions> {
  const { mountShare } = await import('../../src/share/mount');
  const options: ShareMountOptions = {
    root: document.createElement('div'), canvas: document.createElement('canvas'), search: '',
    showroom: {
      currentLook: 'look', currentVariant: 'base', lookYaw: 0,
      showLook: async () => {}, setVariant: async () => {},
    },
    defaultLook: 'look', defaultVariant: 'base',
    lighting: { rig: DEFAULT_RIG, apply: () => {}, serialize: () => DEFAULT_RIG_SERIALIZED },
    camera: {
      orbit: { position: [0, 1, 4], moveTo: () => {} },
      turntable: { yaw: 0, running: false, setYaw: () => {}, start: () => {}, stop: () => {} },
    },
    music: { player: { state: 'off' } }, postFeatures: () => 'off', proofTarget: [0, 1, 0],
    renderer: { getPixelRatio: () => 1, setPixelRatio: () => {} },
    drawFrame: () => {}, onChange: () => {},
  };
  handle = mountShare(options);
  return options;
}

describe('screenshot loading', () => {
  it('does not import during the default share mount', async () => {
    await mount();
    expect(imports).toBe(0);
    expect(capture).not.toHaveBeenCalled();
  });

  it('a copy action after disposal touches no clipboard and no URL', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await mount();
    handle!.dispose();
    handle = null;
    const replace = vi.spyOn(window.history, 'replaceState');
    await actions.copyLink();
    expect(writeText).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('a screenshot action after disposal draws no frame and imports nothing', async () => {
    const options = await mount();
    options.drawFrame = vi.fn();
    handle!.dispose();
    handle = null;
    await actions.screenshot();
    await vi.dynamicImportSettled();
    expect(options.drawFrame).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(imports).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('imports once on screenshot actions and captures each requested still', async () => {
    await mount();
    await actions.screenshot();
    await actions.screenshot();
    expect(imports).toBe(1);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('forgets a failed screenshot import, so the next action retries and succeeds', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    let failNext = true;
    vi.doMock('../../src/share/screenshot', async () => {
      imports += 1;
      if (failNext) {
        failNext = false;
        throw new Error('chunk unavailable');
      }
      return { captureStill: capture, deliverStill: deliver };
    });
    await mount();

    await actions.screenshot();
    expect(imports).toBe(1);
    expect(notify).toHaveBeenCalledExactlyOnceWith('Screenshot failed');

    await actions.screenshot();
    expect(imports).toBe(2);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('Still saved');
    errorLog.mockRestore();
  });

  it.each(['resolve', 'reject'] as const)('retires a pending import on disposal before %s', async (outcome) => {
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    vi.doMock('../../src/share/screenshot', async () => {
      entered();
      await ready;
      return { captureStill: capture, deliverStill: deliver };
    });
    await mount();
    const pending = actions.screenshot();
    await started;
    handle!.dispose();
    if (outcome === 'resolve') finish();
    else fail(new Error('Module unavailable'));
    await pending;
    expect(capture).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  const steps = TIERS.base.scalerSteps;
  const transitions = steps.slice(1).flatMap((next, index) => [
    [steps[index], next], [next, steps[index]],
  ]);
  it.each(transitions)('keeps request dimensions across an import-time ratio change from %s to %s',
    async (requestedRatio, liveRatio) => {
      let finish!: () => void;
      const ready = new Promise<void>((resolve) => { finish = resolve; });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      vi.doMock('../../src/share/screenshot', async () => {
        entered();
        await ready;
        const actual = await vi.importActual<typeof import('../../src/share/screenshot')>(
          '../../src/share/screenshot',
        );
        return { ...actual, deliverStill: deliver };
      });
      const options = await mount();
      // Desktop Chrome's viewport and the full-canvas layout used by the sharing spec.
      const width = 1280;
      const height = 720;
      let ratio = requestedRatio;
      const events: string[] = [];
      const applyRatio = (next: number): void => {
        ratio = next;
        options.canvas.width = Math.floor(width * next);
        options.canvas.height = Math.floor(height * next);
      };
      options.renderer = {
        getPixelRatio: () => ratio,
        setPixelRatio: (next) => { events.push(`ratio:${next}`); applyRatio(next); },
      };
      options.drawFrame = () => { events.push('draw'); };
      const dimensions: { width: number; height: number }[] = [];
      options.canvas.toBlob = (callback) => {
        events.push('blob');
        dimensions.push({ width: options.canvas.width, height: options.canvas.height });
        callback(new Blob(['still'], { type: 'image/png' }));
      };
      applyRatio(requestedRatio);
      const requestSize = { width: options.canvas.width, height: options.canvas.height };
      const pending = actions.screenshot();
      await started;
      expect(events).toEqual([]);
      applyRatio(liveRatio);
      finish();
      await pending;
      expect(dimensions).toHaveLength(1);
      expect(Math.abs(dimensions[0].width - requestSize.width * 2)).toBeLessThanOrEqual(FLOOR_TOLERANCE_PX);
      expect(Math.abs(dimensions[0].height - requestSize.height * 2)).toBeLessThanOrEqual(FLOOR_TOLERANCE_PX);
      expect(events).toEqual([`ratio:${requestedRatio * 2}`, 'draw', 'blob', `ratio:${liveRatio}`]);
      expect(ratio).toBe(liveRatio);
      expect(options.canvas.width).toBe(Math.floor(width * liveRatio));
      expect(options.canvas.height).toBe(Math.floor(height * liveRatio));
    },
  );
});
