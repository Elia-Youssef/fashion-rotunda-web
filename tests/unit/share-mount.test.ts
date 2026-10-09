// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MUSIC_STORAGE_KEY } from '../../src/audio/preference';
import { DEFAULT_RIG } from '../../src/lighting/rig';
import { mountShare } from '../../src/share/mount';
import type { ShareMount, ShareMountOptions } from '../../src/share/mount';
import { DEFAULT_RIG_SERIALIZED } from '../../src/share/state';

const DEFAULT_LOOK = 'look-01';
const DEFAULT_VARIANT = 'light';
const PROOF_POSITION: [number, number, number] = [0, 1.7, 4.2];
const PROOF_TARGET: [number, number, number] = [0, 1, 0];

/** Everything the mount reads through its handles, as fields a test moves by hand. */
interface Live {
  currentLook: string | null;
  currentVariant: string | null;
  position: [number, number, number];
  /** Every pose the mount asked the orbit to move to, in order. */
  moved: [number, number, number][];
  yaw: number;
  running: boolean;
  rig: string;
  post: string;
  playerState: string;
}

interface Stage {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  musicSwitch: HTMLElement;
  live: Live;
  options: ShareMountOptions;
}

/** performance.now, not the timer clock: the mount throttles on the former and sleeps on the latter. */
const clock = { ms: 0 };
let mounts: ShareMount[] = [];

function makeStage(search: string): Stage {
  const root = document.createElement('aside');
  document.body.appendChild(root);
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const musicSwitch = document.createElement('button');
  musicSwitch.className = 'music-switch';
  musicSwitch.dataset.music = 'armed';
  document.body.appendChild(musicSwitch);

  const live: Live = {
    currentLook: null,
    currentVariant: null,
    position: [...PROOF_POSITION],
    moved: [],
    yaw: 0,
    running: false,
    rig: DEFAULT_RIG_SERIALIZED,
    post: 'ao,traa',
    playerState: 'armed',
  };

  const options: ShareMountOptions = {
    root,
    search,
    showroom: {
      get currentLook(): string | null {
        return live.currentLook;
      },
      get currentVariant(): string | null {
        return live.currentVariant;
      },
      showLook: async (): Promise<void> => undefined,
      setVariant: async (): Promise<void> => undefined,
      lookYaw: 0,
    },
    defaultLook: DEFAULT_LOOK,
    defaultVariant: DEFAULT_VARIANT,
    lighting: {
      rig: DEFAULT_RIG,
      apply: (): void => undefined,
      serialize: (): string => live.rig,
    },
    camera: {
      orbit: {
        get position(): [number, number, number] {
          return live.position;
        },
        moveTo: (position: [number, number, number]): void => {
          live.moved.push(position);
          live.position = [...position];
        },
      },
      turntable: {
        get yaw(): number {
          return live.yaw;
        },
        get running(): boolean {
          return live.running;
        },
        setYaw: (radians: number): void => {
          live.yaw = radians;
        },
        start: (): void => {
          live.running = true;
        },
        stop: (): void => {
          live.running = false;
        },
      },
    },
    music: {
      player: {
        get state(): string {
          return live.playerState;
        },
      },
    },
    postFeatures: (): string => live.post,
    proofTarget: PROOF_TARGET,
    renderer: { getPixelRatio: (): number => 1, setPixelRatio: (): void => undefined },
    canvas,
    drawFrame: (): void => undefined,
    onChange: (): void => undefined,
  };

  return { root, canvas, musicSwitch, live, options };
}

function mount(stage: Stage): ShareMount {
  const handle = mountShare(stage.options);
  mounts.push(handle);
  return handle;
}

/** Advances the timers and performance.now together, in steps small enough to see the throttle. */
async function tick(ms: number): Promise<void> {
  let left = ms;
  while (left > 0) {
    const step = Math.min(10, left);
    clock.ms += step;
    await vi.advanceTimersByTimeAsync(step);
    left -= step;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  clock.ms = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.ms);
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
  mounts = [];
});

afterEach(() => {
  for (const handle of mounts) {
    handle.dispose();
  }
  mounts = [];
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('share mount', () => {
  it.each(['resolve', 'reject'] as const)('retires clipboard %s after disposal', async (outcome) => {
    const pending = deferred<void>();
    const writeText = vi.fn(() => pending.promise);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const stage = makeStage('');
    const handle = mount(stage);
    const status = stage.root.querySelector('.share__status')!;
    stage.root.querySelector<HTMLButtonElement>('.share__button--copy')!.click();
    expect(writeText).toHaveBeenCalledTimes(1);
    handle.dispose();
    const replacement = document.createElement('input');
    replacement.className = 'share__fallback share__fallback--hidden';
    stage.root.appendChild(replacement);
    const focus = vi.spyOn(replacement, 'focus');
    const select = vi.spyOn(replacement, 'select');
    const replace = vi.spyOn(window.history, 'replaceState');
    expect(vi.getTimerCount()).toBe(0);
    if (outcome === 'resolve') pending.resolve(undefined);
    else pending.reject(new Error('Clipboard refused'));
    await vi.advanceTimersByTimeAsync(0);
    expect(status.textContent).toBe('');
    expect(replacement.value).toBe('');
    expect(replacement.classList.contains('share__fallback--hidden')).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)('retires capture %s after disposal', async (outcome) => {
    const stage = makeStage('');
    let finishCapture!: BlobCallback;
    vi.spyOn(stage.canvas, 'toBlob').mockImplementation((callback) => { finishCapture = callback; });
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { canShare: () => true, share });
    const createURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:retired');
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    stage.options.drawFrame = vi.fn();
    stage.options.onChange = vi.fn();
    stage.options.renderer.setPixelRatio = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handle = mount(stage);
    const status = stage.root.querySelector('.share__status')!;
    stage.root.querySelector<HTMLButtonElement>('.share__button--screenshot')!.click();
    expect(stage.options.drawFrame).toHaveBeenCalledTimes(1);
    expect(stage.options.renderer.setPixelRatio).toHaveBeenCalledTimes(2);
    handle.dispose();
    finishCapture(outcome === 'resolve' ? new Blob(['still'], { type: 'image/png' }) : null);
    await vi.advanceTimersByTimeAsync(0);
    expect(stage.options.onChange).not.toHaveBeenCalled();
    expect(stage.options.drawFrame).toHaveBeenCalledTimes(1);
    expect(stage.options.renderer.setPixelRatio).toHaveBeenCalledTimes(2);
    expect(share).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(createURL).not.toHaveBeenCalled();
    expect(status.textContent).toBe('');
    expect(error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)('retires delivery %s after disposal', async (outcome) => {
    const stage = makeStage('');
    vi.spyOn(stage.canvas, 'toBlob').mockImplementation((callback) => {
      callback(new Blob(['still'], { type: 'image/png' }));
    });
    const pending = deferred<void>();
    const share = vi.fn(() => pending.promise);
    vi.stubGlobal('navigator', { canShare: () => true, share });
    const createURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:retired');
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    stage.options.drawFrame = vi.fn();
    stage.options.onChange = vi.fn();
    const handle = mount(stage);
    const status = stage.root.querySelector('.share__status')!;
    stage.root.querySelector<HTMLButtonElement>('.share__button--screenshot')!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(share).toHaveBeenCalledTimes(1);
    expect(stage.options.onChange).toHaveBeenCalledTimes(1);
    handle.dispose();
    expect(vi.getTimerCount()).toBe(0);
    if (outcome === 'resolve') pending.resolve(undefined);
    else pending.reject(new Error('Share refused'));
    await vi.advanceTimersByTimeAsync(0);
    expect(download).not.toHaveBeenCalled();
    expect(createURL).not.toHaveBeenCalled();
    expect(stage.options.onChange).toHaveBeenCalledTimes(1);
    expect(stage.options.drawFrame).toHaveBeenCalledTimes(1);
    expect(status.textContent).toBe('');
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('writes the address bar with replaceState and never pushState', async () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    const push = vi.spyOn(window.history, 'pushState');
    const stage = makeStage('');
    mount(stage);

    stage.canvas.dataset.look = 'look-03';
    await tick(300);

    expect(replace).toHaveBeenCalled();
    // The back button must not walk through camera moves and swatch presses.
    expect(push).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?look=look-03');
  });

  it('keeps a bare URL on the catalogue default look and swatch', async () => {
    const stage = makeStage('');
    mount(stage);

    stage.live.currentLook = DEFAULT_LOOK;
    stage.live.currentVariant = DEFAULT_VARIANT;
    stage.canvas.dataset.look = DEFAULT_LOOK;
    await tick(600);

    expect(window.location.search).toBe('');
  });

  it('writes at most once per 250 ms however fast the page changes', async () => {
    const stage = makeStage('');
    mount(stage);
    // The first write clears the throttle window, so the burst below starts from a known moment.
    stage.canvas.dataset.look = 'look-02';
    await tick(260);
    const replace = vi.spyOn(window.history, 'replaceState');

    for (let i = 0; i < 5; i += 1) {
      stage.canvas.dataset.look = `look-1${i}`;
      await tick(20);
    }

    expect(replace).not.toHaveBeenCalled();
    await tick(200);
    expect(replace).toHaveBeenCalledTimes(1);
    // The one write carries the last value, not the first.
    expect(window.location.search).toBe('?look=look-14');
  });

  it('writes turn=1 and no yaw while the turntable runs', async () => {
    const stage = makeStage('');
    mount(stage);

    stage.live.running = true;
    stage.live.yaw = 1.234;
    stage.canvas.dataset.yaw = '1.234';
    await tick(300);
    expect(window.location.search).toBe('?turn=1');

    // A yaw written every 250 ms is what Safari counts against its 100 calls in 30 s, so the
    // angle is only written once the table stops.
    const replace = vi.spyOn(window.history, 'replaceState');
    stage.live.yaw = 2.345;
    stage.canvas.dataset.yaw = '2.345';
    await tick(600);
    expect(replace).not.toHaveBeenCalled();

    stage.live.running = false;
    await tick(300);
    expect(window.location.search).toBe('?yaw=2.345');
  });

  it('restores a linked camera pose and turntable at boot', () => {
    const stage = makeStage('?cam=1.500,2.000,3.000&yaw=1.000&turn=1');
    mount(stage);

    // moveTo, so the card's Reset still returns to the proof view.
    expect(stage.live.moved).toEqual([[1.5, 2, 3]]);
    expect(stage.live.yaw).toBe(1);
    expect(stage.live.running).toBe(true);
  });

  it('keeps a linked post override until the chain itself changes', async () => {
    const stage = makeStage('?post=off');
    window.history.replaceState(null, '', '/?post=off');
    stage.live.post = 'off';
    mount(stage);

    await tick(600);
    expect(window.location.search).toBe('?post=off');

    // The chain came back with its features, so the override no longer describes the page.
    stage.live.post = 'ao,traa';
    await tick(300);
    expect(window.location.search).toBe('');
  });

  it('reads the music from the stored preference, not the player state', async () => {
    const stage = makeStage('');
    stage.live.playerState = 'paused';
    mount(stage);

    // A paused player with nothing stored is a page nobody has answered for yet.
    await tick(300);
    expect(window.location.search).toBe('');

    window.localStorage.setItem(MUSIC_STORAGE_KEY, 'off');
    stage.musicSwitch.dataset.music = 'off';
    await tick(300);
    expect(window.location.search).toBe('?music=off');
  });

  it('dispose releases the interval, the pending timer and both observers', async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    const stage = makeStage('');
    const handle = mount(stage);

    stage.canvas.dataset.look = 'look-03';
    await tick(300);
    // A change inside the throttle window leaves a timer armed for dispose to find.
    stage.canvas.dataset.look = 'look-04';
    await tick(20);
    expect(vi.getTimerCount()).toBeGreaterThan(1);

    handle.dispose();
    expect(vi.getTimerCount()).toBe(0);
    // The canvas observer and the music switch observer, both let go.
    expect(disconnect).toHaveBeenCalledTimes(2);

    const replace = vi.spyOn(window.history, 'replaceState');
    stage.canvas.dataset.look = 'look-05';
    stage.musicSwitch.dataset.music = 'off';
    await tick(1000);
    expect(replace).not.toHaveBeenCalled();
    expect(stage.root.querySelector('.share')).toBeNull();
  });
});
