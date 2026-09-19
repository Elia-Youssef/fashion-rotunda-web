// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountMusic } from '../../src/audio/mount';
import type { MusicMount } from '../../src/audio/mount';

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
});

afterEach(() => {
  mounted?.dispose();
  mounted = null;
  header.remove();
  vi.unstubAllGlobals();
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
