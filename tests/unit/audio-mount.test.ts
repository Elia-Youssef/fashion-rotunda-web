// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountMusic } from '../../src/audio/mount';
import type { MusicMount } from '../../src/audio/mount';
import type { AudioBuses, AudioEngine } from '../../src/audio/engine';
import { MUSIC_STORAGE_KEY } from '../../src/audio/preference';

// The mount is driven through the same kind of fakes the player test uses, one level lower: the
// engine is the real one and the AudioContext under it is the fake, so the state listener the
// mount subscribes to is fired exactly the way a browser fires it (the state moves, then
// statechange). That is the only way to reach the interruption path, which has no other trigger.

const MANIFEST_DURATION = 105.65;

class FakeParam {
  value = 0;
  setValueAtTime(value: number): void {
    this.value = value;
  }
  linearRampToValueAtTime(value: number): void {
    // The end value stands in for the ramp; nothing here reads a value mid-ramp.
    this.value = value;
  }
  cancelScheduledValues(): void {
    // Scheduling is the player's business and is asserted in the player test.
  }
}

class FakeGain {
  readonly gain = new FakeParam();
  connect(node: unknown): unknown {
    return node;
  }
  disconnect(): void {
    // Nothing to release in a fake graph.
  }
}

class FakeSource {
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  connect(node: unknown): unknown {
    return node;
  }
  disconnect(): void {
    // Nothing to release in a fake graph.
  }
  start(): void {
    // Started is all the mount cares about; the player test checks when and from where.
  }
  stop(): void {
    // Stopped is all the mount cares about.
  }
}

class FakeAudioContext {
  static created: FakeAudioContext[] = [];
  currentTime = 0;
  state: AudioContextState = 'suspended';
  onstatechange: (() => void) | null = null;
  readonly destination = { name: 'destination' };
  /** Where resume() lands. A context that will not run is the interruption this test models. */
  resumesTo: AudioContextState = 'running';

  constructor() {
    FakeAudioContext.created.push(this);
  }

  createGain(): FakeGain {
    return new FakeGain();
  }

  createBufferSource(): FakeSource {
    return new FakeSource();
  }

  async decodeAudioData(): Promise<unknown> {
    return {
      duration: MANIFEST_DURATION,
      length: 5_071_200,
      numberOfChannels: 2,
      sampleRate: 48_000,
    };
  }

  async resume(): Promise<void> {
    this.moveTo(this.resumesTo);
  }

  async close(): Promise<void> {
    this.moveTo('closed');
  }

  /** A browser moves the state and then fires statechange; a repeat of the same state fires not. */
  moveTo(state: AudioContextState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.onstatechange?.();
  }
}

function manifestJson(): unknown {
  return {
    version: 1,
    default: 'music-01',
    tracks: [
      {
        id: 'music-01',
        title: 'Track 1',
        duration: MANIFEST_DURATION,
        sources: [{ url: 'music-01.ogg', type: 'audio/ogg; codecs="opus"', bytes: 100 }],
      },
    ],
  };
}

let header: HTMLElement;
let mounted: MusicMount | null = null;
let fetchMock: ReturnType<typeof vi.fn>;
/** Mutable on purpose: a gesture is what flips hasBeenActive in a real browser too. */
let activation: { hasBeenActive: boolean };

/** Two macrotask turns drain every promise chain the fakes queue; none of them does real I/O. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function context(): FakeAudioContext {
  const found = FakeAudioContext.created[0];
  if (found === undefined) {
    throw new Error('no AudioContext was created');
  }
  return found;
}

function button(): HTMLButtonElement {
  const found = header.querySelector<HTMLButtonElement>('button.music-switch');
  if (found === null) {
    throw new Error('no switch button in the header');
  }
  return found;
}

beforeEach(() => {
  FakeAudioContext.created = [];
  header = document.createElement('header');
  document.body.appendChild(header);
  activation = { hasBeenActive: true };
  fetchMock = vi.fn(async (input: unknown) => {
    if (String(input).endsWith('music.json')) {
      return { ok: true, status: 200, json: async () => manifestJson() };
    }
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(64) };
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('navigator', { userActivation: activation });
  vi.stubGlobal(
    'Audio',
    class {
      canPlayType(): string {
        return 'probably';
      }
    },
  );
  localStorage.clear();
  delete window.archvizMusic;
});

afterEach(() => {
  mounted?.dispose();
  mounted = null;
  header.remove();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('music mount lifetime', () => {
  it.each([
    ['pause', 'suspended', 'refused'],
    ['pause', 'interrupted', 'running'],
    ['play', 'suspended', 'refused'],
    ['play', 'interrupted', 'running'],
  ] as const)('retires recovery during %s after %s with %s unlock', async (stage, state, outcome) => {
    let stateChanged!: Parameters<AudioEngine['onStateChange']>[0];
    let finishFirst!: (buses: AudioBuses | null) => void;
    let finishRecovery!: (buses: AudioBuses | null) => void;
    const first = new Promise<AudioBuses | null>((resolve) => { finishFirst = resolve; });
    const recovery = new Promise<AudioBuses | null>((resolve) => { finishRecovery = resolve; });
    const unlock = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(recovery).mockResolvedValue(null);
    const release = vi.fn();
    const engine: AudioEngine = {
      buses: null, unlock, dispose: vi.fn(),
      onStateChange: (listener) => { stateChanged = listener; return release; },
    };
    mounted = mountMusic({ headerRoot: header, search: '?music=off', baseUrl: '/content/music', engine });
    const starting = mounted.player.play();
    expect(mounted.player.state).toBe('loading');
    const play = vi.spyOn(mounted.player, 'play');
    const realPause = mounted.player.pause;
    let finishPause!: () => void;
    const pauseGate = new Promise<void>((resolve) => { finishPause = resolve; });
    const pause = vi.spyOn(mounted.player, 'pause').mockImplementation(async () => {
      await realPause();
      if (stage === 'pause') await pauseGate;
    });
    stateChanged('running');
    stateChanged(state);
    if (stage === 'play') await settle();
    expect(pause).toHaveBeenCalledTimes(1);
    expect(unlock).toHaveBeenCalledTimes(stage === 'play' ? 2 : 1);
    mounted.dispose();
    expect(release).toHaveBeenCalledTimes(1);
    const registrations = vi.spyOn(window, 'addEventListener');
    const plays = play.mock.calls.length;
    const unlocks = unlock.mock.calls.length;
    finishPause();
    const fakeContext = new FakeAudioContext();
    const buses: AudioBuses = {
      context: fakeContext as unknown as AudioContext,
      music: new FakeGain() as unknown as GainNode,
    };
    finishRecovery(outcome === 'running' ? buses : null);
    finishFirst(null);
    await starting;
    await settle();
    // A callback dispatched before the subscription was released also belongs to the retired mount.
    stateChanged('running');
    stateChanged(state);
    window.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('keydown'));
    await mounted.startDeferred();
    await settle();
    expect(registrations.mock.calls.filter(([type]) => type === 'pointerdown' || type === 'keydown')).toEqual([]);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(play).toHaveBeenCalledTimes(plays);
    expect(unlock).toHaveBeenCalledTimes(unlocks);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retires deferred start and armed gestures before playback starts', async () => {
    activation.hasBeenActive = false;
    mounted = mountMusic({
      headerRoot: header, search: '?music=on', baseUrl: '/content/music', deferPlay: true,
    });
    const unlock = vi.spyOn(mounted.engine, 'unlock');
    const play = vi.spyOn(mounted.player, 'play');
    const retained = button();
    mounted.dispose();
    const registrations = vi.spyOn(window, 'addEventListener');
    await mounted.startDeferred();
    activation.hasBeenActive = true;
    retained.click();
    window.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('keydown'));
    await settle();
    expect(registrations.mock.calls.filter(([type]) => type === 'pointerdown' || type === 'keydown')).toEqual([]);
    expect(play).not.toHaveBeenCalled();
    expect(unlock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('mountMusic and an interrupted context', () => {
  it('stops claiming to play, and the next gesture brings the loop back', async () => {
    mounted = mountMusic({ headerRoot: header, search: '?music=on', baseUrl: '/content/music' });
    await settle();
    expect(mounted.player.state, 'a gesture had already happened, so it plays').toBe('playing');
    expect(button().dataset.music).toBe('playing');

    // iOS after a phone call: the context leaves running and will not resume outside a gesture.
    context().resumesTo = 'interrupted';
    context().moveTo('interrupted');
    await settle();

    // Not playing any more, which is the point: the switch stopped claiming sound there is none
    // of. The exact landing is error rather than armed because this browser exposes
    // userActivation, so the player can tell a refused context from a missing gesture and says so.
    // Error keeps the button pressable and the recovery keeps the listeners, so both routes back
    // are open.
    expect(mounted.player.state).toBe('error');
    expect(button().dataset.music).toBe('error');
    expect(button().disabled, 'the retry has to be pressable').toBe(false);

    // The next gesture anywhere on the page is what a visitor actually does next, and it has to
    // reach the music again: the listeners were reinstalled by the recovery.
    context().resumesTo = 'running';
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    expect(mounted.player.state, 'the gesture brought the loop back').toBe('playing');
  });

  it('arms rather than errors where the browser gives no userActivation to read', async () => {
    // Without the property the player cannot tell a refused context from a missing gesture, so it
    // arms; with it, the refusal is an error. Both are pressable and both keep the listeners.
    vi.stubGlobal('navigator', {});
    mounted = mountMusic({ headerRoot: header, search: '?music=on', baseUrl: '/content/music' });
    await settle();
    expect(mounted.player.state).toBe('playing');

    context().resumesTo = 'interrupted';
    context().moveTo('interrupted');
    await settle();
    expect(mounted.player.state).toBe('armed');
    expect(button().textContent).toContain('Music on');
  });

  it('reads a first suspended context as a start, not as a loss', async () => {
    // Every context is born suspended and the engine reports that reading before resuming it, all
    // inside the boot's own play(). A recovery fired there retires the load that created the
    // context: the end state still converges on playing, so the only place the difference shows
    // is right here, before the first await, where the switch would already read off.
    mounted = mountMusic({ headerRoot: header, search: '?music=on', baseUrl: '/content/music' });
    expect(button().dataset.music, 'the boot load survives the context being born suspended').toBe(
      'loading',
    );
    await settle();
    expect(mounted.player.state).toBe('playing');
    expect(fetchMock, 'the manifest and the file, once each').toHaveBeenCalledTimes(2);
  });

  it('ignores a suspension while the music is off', async () => {
    mounted = mountMusic({ headerRoot: header, search: '?music=off', baseUrl: '/content/music' });
    await settle();
    expect(mounted.player.state).toBe('off');
    expect(FakeAudioContext.created, 'music=off creates no context').toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts nothing when the interruption arrives while the music is off', async () => {
    mounted = mountMusic({ headerRoot: header, search: '', baseUrl: '/content/music' });
    await settle();
    expect(mounted.player.state).toBe('playing');

    // The visitor stopped the music, then the phone call comes. There is nothing to recover:
    // starting the loop again would be music nobody asked for.
    button().click();
    await settle();
    expect(mounted.player.state).toBe('off');

    context().resumesTo = 'interrupted';
    context().moveTo('interrupted');
    await settle();
    expect(mounted.player.state, 'off stays off').toBe('off');
    expect(button().dataset.music).toBe('off');
  });
});

describe('mountMusic and the first gesture', () => {
  it('ignores a gesture that lands on the switch, whose own click decides', async () => {
    activation.hasBeenActive = false;
    mounted = mountMusic({ headerRoot: header, search: '?music=on', baseUrl: '/content/music' });
    await settle();
    expect(mounted.player.state).toBe('armed');
    expect(fetchMock).not.toHaveBeenCalled();

    // The press that follows is a real gesture, so the only thing that can keep the fetch from
    // starting here is the target check.
    activation.hasBeenActive = true;
    button().dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    expect(fetchMock, 'the switch press starts no fetch of its own').not.toHaveBeenCalled();
    expect(mounted.player.state, 'still armed, waiting for the click to decide').toBe('armed');

    // The click is what decides, and on an armed switch it means no.
    button().click();
    await settle();
    expect(mounted.player.state).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts on a gesture anywhere else on the page', async () => {
    activation.hasBeenActive = false;
    mounted = mountMusic({ headerRoot: header, search: '?music=on', baseUrl: '/content/music' });
    await settle();
    expect(mounted.player.state).toBe('armed');

    activation.hasBeenActive = true;
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    expect(mounted.player.state).toBe('playing');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('listens for a key as well as a pointer, and only until one of them fires', async () => {
    activation.hasBeenActive = false;
    mounted = mountMusic({ headerRoot: header, search: '?music=on', baseUrl: '/content/music' });
    await settle();

    activation.hasBeenActive = true;
    window.dispatchEvent(new Event('keydown'));
    await settle();
    expect(mounted.player.state).toBe('playing');

    // A second gesture must not start a second load: the listeners went with the first.
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('mountMusic and the stored preference', () => {
  it('honours a stored off preference', async () => {
    localStorage.setItem(MUSIC_STORAGE_KEY, 'off');
    mounted = mountMusic({ headerRoot: header, search: '', baseUrl: '/content/music' });
    await settle();
    expect(mounted.player.state).toBe('off');
    expect(FakeAudioContext.created, 'a stored no creates no context').toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a store that cannot be read as no store, not as off', async () => {
    const owner =
      Object.getOwnPropertyDescriptor(window, 'localStorage') ??
      Object.getOwnPropertyDescriptor(Window.prototype, 'localStorage');
    if (owner === undefined) {
      throw new Error('no localStorage descriptor to restore');
    }
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage blocked');
      },
    });
    try {
      mounted = mountMusic({ headerRoot: header, search: '', baseUrl: '/content/music' });
      await settle();
      expect(mounted.player.state, 'the default preference still applies').toBe('playing');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(window, 'localStorage', owner);
    }
  });

  it('stores the choice each toggle makes', async () => {
    mounted = mountMusic({ headerRoot: header, search: '', baseUrl: '/content/music' });
    await settle();
    expect(mounted.player.state).toBe('playing');

    button().click();
    await settle();
    expect(mounted.player.state).toBe('off');
    expect(localStorage.getItem(MUSIC_STORAGE_KEY)).toBe('off');

    button().click();
    await settle();
    expect(mounted.player.state).toBe('playing');
    expect(localStorage.getItem(MUSIC_STORAGE_KEY)).toBe('on');
  });

  it('stores on when the visitor retries from an error', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 500,
      json: async () => manifestJson(),
      arrayBuffer: async () => new ArrayBuffer(64),
    }));
    mounted = mountMusic({ headerRoot: header, search: '', baseUrl: '/content/music' });
    await settle();
    expect(mounted.player.state).toBe('error');

    button().click();
    await settle();
    expect(localStorage.getItem(MUSIC_STORAGE_KEY)).toBe('on');
  });
});

describe('mountMusic and the armed listeners', () => {
  it('drops the listeners when the visitor declines the armed music', async () => {
    activation.hasBeenActive = false;
    mounted = mountMusic({ headerRoot: header, search: '?music=on', baseUrl: '/content/music' });
    await settle();
    expect(mounted.player.state).toBe('armed');

    button().click();
    await settle();
    expect(mounted.player.state).toBe('off');

    // The visitor said no; a later gesture anywhere on the page is not a change of mind.
    activation.hasBeenActive = true;
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    expect(mounted.player.state).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('listens again when the music is switched back on before any gesture', async () => {
    activation.hasBeenActive = false;
    mounted = mountMusic({ headerRoot: header, search: '?music=on', baseUrl: '/content/music' });
    await settle();
    button().click();
    await settle();
    expect(mounted.player.state).toBe('off');

    button().click();
    await settle();
    expect(mounted.player.state, 'armed again through the switch').toBe('armed');

    activation.hasBeenActive = true;
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    expect(mounted.player.state, 'the re-armed listeners heard it').toBe('playing');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('leaves no listener behind when the starting gesture fails to load', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 500,
      json: async () => manifestJson(),
      arrayBuffer: async () => new ArrayBuffer(64),
    }));
    activation.hasBeenActive = false;
    mounted = mountMusic({ headerRoot: header, search: '?music=on', baseUrl: '/content/music' });
    await settle();
    expect(mounted.player.state).toBe('armed');

    activation.hasBeenActive = true;
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    expect(mounted.player.state).toBe('error');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The one gesture the listener existed for has happened; a retry needs the switch.
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await settle();
    expect(mounted.player.state).toBe('error');
    expect(fetchMock, 'no second fetch from a leftover listener').toHaveBeenCalledTimes(1);
  });

  it('hears the gesture before a handler that stops propagation', async () => {
    activation.hasBeenActive = false;
    mounted = mountMusic({ headerRoot: header, search: '?music=on', baseUrl: '/content/music' });
    await settle();
    const swallow = (event: Event): void => {
      event.stopPropagation();
    };
    document.body.addEventListener('pointerdown', swallow);
    try {
      activation.hasBeenActive = true;
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      await settle();
      expect(mounted.player.state, 'capture beats the swallowing handler').toBe('playing');
    } finally {
      document.body.removeEventListener('pointerdown', swallow);
    }
  });
});

describe('mountMusic and the deferred start', () => {
  it('draws the armed switch while the deferred start waits', () => {
    mounted = mountMusic({
      headerRoot: header, search: '?music=on', baseUrl: '/content/music', deferPlay: true,
    });
    expect(button().dataset.music, 'armed from the state alone, nothing fetched behind it').toBe(
      'armed',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts nothing for a visitor whose choice is off', async () => {
    mounted = mountMusic({
      headerRoot: header, search: '?music=off', baseUrl: '/content/music', deferPlay: true,
    });
    await mounted.startDeferred();
    await settle();
    expect(mounted.player.state).toBe('off');
    expect(FakeAudioContext.created).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('plays the deferred start for the on preference', async () => {
    mounted = mountMusic({
      headerRoot: header, search: '?music=on', baseUrl: '/content/music', deferPlay: true,
    });
    await mounted.startDeferred();
    await settle();
    expect(mounted.player.state).toBe('playing');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('the e2e handle on window', () => {
  it('exposes the live state while the page runs in dev', async () => {
    mounted = mountMusic({ headerRoot: header, search: '', baseUrl: '/content/music' });
    expect(window.archvizMusic).toBeDefined();
    await settle();
    expect(window.archvizMusic?.state()).toBe('playing');
  });

  it('follows the e2e switch only when dev is off', () => {
    vi.stubEnv('DEV', false);
    const withSwitch = mountMusic({
      headerRoot: header, search: '?e2e=1', baseUrl: '/content/music',
    });
    expect(window.archvizMusic).toBeDefined();
    withSwitch.dispose();
    expect(window.archvizMusic).toBeUndefined();

    mounted = mountMusic({ headerRoot: header, search: '', baseUrl: '/content/music' });
    expect(window.archvizMusic, 'no switch, no handle').toBeUndefined();
  });

  it('reads the position from the loop clock', async () => {
    mounted = mountMusic({ headerRoot: header, search: '', baseUrl: '/content/music' });
    await settle();
    context().currentTime = 10;
    expect(window.archvizMusic?.position()).toBe(10);
  });

  it('is gone after dispose', async () => {
    mounted = mountMusic({ headerRoot: header, search: '', baseUrl: '/content/music' });
    await settle();
    mounted.dispose();
    mounted = null;
    expect(window.archvizMusic).toBeUndefined();
  });
});

describe('mountMusic dispose', () => {
  it('removes the switch from the header', () => {
    mounted = mountMusic({ headerRoot: header, search: '', baseUrl: '/content/music' });
    expect(header.querySelector('button.music-switch')).not.toBeNull();
    mounted.dispose();
    mounted = null;
    expect(header.querySelector('button.music-switch')).toBeNull();
  });

  it('closes the audio context', async () => {
    mounted = mountMusic({ headerRoot: header, search: '', baseUrl: '/content/music' });
    await settle();
    expect(mounted.player.state).toBe('playing');
    mounted.dispose();
    mounted = null;
    expect(context().state).toBe('closed');
  });
});
