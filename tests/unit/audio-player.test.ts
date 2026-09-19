// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AudioBuses, AudioEngine } from '../../src/audio/engine';
import { createMusicPlayer } from '../../src/audio/music';
import type { MusicState } from '../../src/audio/music';

// The player is driven through fakes: a context that hands out gain and source nodes that record
// what the player asks them to do, an engine that always unlocks, and fetch/Audio stubs. The one
// cast below, on the buses object, is the only way a hand-written double can enter the DOM's
// concrete audio types, which jsdom does not implement; it is explained in the report.

class FakeParam {
  value = 0;
  calls: Array<[name: string, value: number, time: number]> = [];
  setValueAtTime(value: number, startTime: number): void {
    this.value = value;
    this.calls.push(['set', value, startTime]);
  }
  linearRampToValueAtTime(value: number, endTime: number): void {
    // The end value stands in for the ramp: the player reads .value only after a ramp finished.
    this.value = value;
    this.calls.push(['ramp', value, endTime]);
  }
  cancelScheduledValues(cancelTime: number): void {
    this.calls.push(['cancel', Number.NaN, cancelTime]);
  }
}

class FakeGain {
  readonly gain = new FakeParam();
  connectedTo: unknown[] = [];
  connect(node: unknown): unknown {
    this.connectedTo.push(node);
    return node;
  }
  disconnect(): void {
    this.connectedTo = [];
  }
}

class FakeSource {
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  started: { when: number; offset: number } | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  connectedTo: unknown[] = [];
  connect(node: unknown): unknown {
    this.connectedTo.push(node);
    return node;
  }
  disconnect(): void {
    this.connectedTo = [];
  }
  start(when?: number, offset?: number): void {
    this.started = { when: when ?? 0, offset: offset ?? 0 };
  }
  stop(when?: number): void {
    this.stoppedAt = when ?? 0;
  }
}

const MANIFEST_DURATION = 105.65;

class FakeContext {
  currentTime = 0;
  readonly destination = { name: 'destination' };
  readonly gains: FakeGain[] = [];
  readonly sources: FakeSource[] = [];
  decodeCount = 0;
  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  async decodeAudioData(data: ArrayBuffer): Promise<unknown> {
    this.decodeCount += 1;
    expect(data.byteLength).toBeGreaterThan(0);
    // Padded on purpose: the player must take loopEnd from the manifest, not from this buffer.
    return { duration: MANIFEST_DURATION + 0.9, length: 5_073_120, numberOfChannels: 2, sampleRate: 48_000 };
  }
}

interface FakeWorld {
  engine: AudioEngine;
  context: FakeContext;
  buses: AudioBuses;
  fetchMock: ReturnType<typeof vi.fn>;
}

interface TestSource {
  url: string;
  type: string;
  bytes: number;
}

interface TestManifest {
  version: number;
  default: string;
  tracks: Array<{ id: string; title: string; duration: number; sources: TestSource[] }>;
}

function manifestJson(): TestManifest {
  return {
    version: 1,
    default: 'music-01',
    tracks: [
      {
        id: 'music-01',
        title: 'Track 1',
        duration: MANIFEST_DURATION,
        sources: [
          { url: 'music-01.ogg', type: 'audio/ogg; codecs="opus"', bytes: 100 },
          { url: 'music-01.m4a', type: 'audio/mp4; codecs="mp4a.40.2"', bytes: 200 },
        ],
      },
      { id: 'music-02', title: 'Track 2', duration: 36.6, sources: [] },
    ],
  };
}

function mountPlayer(world: FakeWorld, states: MusicState[], trackId: string | null = null) {
  return createMusicPlayer({
    engine: world.engine,
    baseUrl: '/content/music',
    trackId,
    level: 0.5,
    fadeMs: 400,
    onStateChange: (state) => states.push(state),
  });
}

function fakeWorld(): FakeWorld {
  const context = new FakeContext();
  const buses = {
    context,
    music: new FakeGain(),
    voice: new FakeGain(),
  } as unknown as AudioBuses;
  let unlockCount = 0;
  const engine: AudioEngine = {
    get buses(): AudioBuses | null {
      return unlockCount > 0 ? buses : null;
    },
    async unlock(): Promise<AudioBuses | null> {
      unlockCount += 1;
      return buses;
    },
    onStateChange: () => () => undefined,
    dispose: () => undefined,
  };
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('music.json')) {
      return { ok: true, status: 200, json: async () => manifestJson() };
    }
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(64) };
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal(
    'Audio',
    class {
      canPlayType(): string {
        return 'probably';
      }
    },
  );
  return { engine, context, buses, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createMusicPlayer.play', () => {
  it('fetches, decodes and starts a looping source at the manifest duration', async () => {
    const world = fakeWorld();
    const states: MusicState[] = [];
    const player = mountPlayer(world, states);
    expect(player.state).toBe('off');
    expect(player.position).toBe(0);

    await player.play();
    expect(states).toEqual(['loading', 'playing']);
    expect(world.fetchMock).toHaveBeenCalledTimes(2);
    expect(world.context.decodeCount).toBe(1);

    const node = world.context.sources[0];
    expect(node.buffer).not.toBeNull();
    expect(node.loop).toBe(true);
    expect(node.loopStart).toBe(0);
    expect(node.loopEnd).toBe(MANIFEST_DURATION);
    expect(node.started).toEqual({ when: 0, offset: 0 });
    expect(node.connectedTo[0]).toBe(world.context.gains[0]);
    expect(world.context.gains[0].connectedTo[0]).toBe(world.buses.music);

    // The fade in: pinned at 0, ramped to the level over fadeMs.
    const calls = world.context.gains[0].gain.calls;
    expect(calls[0]).toEqual(['set', 0, 0]);
    expect(calls[1]).toEqual(['ramp', 0.5, 0.4]);
  });

  it('fetches the manifest once and the file once across a stop and a resume', async () => {
    const world = fakeWorld();
    const player = mountPlayer(world, []);
    await player.play();
    world.context.currentTime = 5;
    await player.pause();
    await player.play();
    expect(world.fetchMock).toHaveBeenCalledTimes(2);
    expect(world.context.decodeCount).toBe(1);
    expect(world.context.sources).toHaveLength(2);
  });

  it('maps a failed manifest fetch to error and retries from the failed step', async () => {
    const world = fakeWorld();
    let failManifest = true;
    world.fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).endsWith('music.json') && failManifest) {
        return { ok: false, status: 500, json: async () => manifestJson() };
      }
      if (String(input).endsWith('music.json')) {
        return { ok: true, status: 200, json: async () => manifestJson() };
      }
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(64) };
    });
    const states: Array<[MusicState, string | null]> = [];
    const player = createMusicPlayer({
      engine: world.engine,
      baseUrl: '/content/music',
      trackId: null,
      level: 0.5,
      fadeMs: 400,
      onStateChange: (state, detail) => states.push([state, detail]),
    });

    await player.play();
    expect(player.state).toBe('error');
    expect(states.at(-1)?.[1]).toContain('music list');

    failManifest = false;
    await player.play();
    expect(player.state).toBe('playing');
    // The failed attempt asked for the manifest and nothing else; the retry asked for the file too.
    expect(world.fetchMock).toHaveBeenCalledTimes(3);
  });

  it('warns once about an unknown track and plays the default', async () => {
    const world = fakeWorld();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const player = mountPlayer(world, [], 'music-99');
    await player.play();
    expect(player.state).toBe('playing');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('music-99');
    await player.pause();
    await player.play();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('plays a known track id when it names one', async () => {
    const world = fakeWorld();
    const manifestWithTwoFiles = manifestJson();
    manifestWithTwoFiles.tracks[1].sources = [
      { url: 'music-02.ogg', type: 'audio/ogg; codecs="opus"', bytes: 100 },
    ];
    world.fetchMock.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('music.json')) {
        return { ok: true, status: 200, json: async () => manifestWithTwoFiles };
      }
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(64) };
    });
    const player = mountPlayer(world, [], 'music-02');
    await player.play();
    expect(player.state).toBe('playing');
    expect(String(world.fetchMock.mock.calls[1][0])).toContain('music-02.ogg');
    expect(world.context.sources[0].loopEnd).toBe(36.6);
  });
});

describe('createMusicPlayer.pause and position', () => {
  it('fades out over fadeMs, stops, freezes the position at once', async () => {
    const world = fakeWorld();
    const player = mountPlayer(world, []);
    await player.play();
    world.context.currentTime = 5;
    await player.pause();

    expect(player.state).toBe('off');
    expect(player.position).toBeCloseTo(5, 9);
    world.context.currentTime = 9;
    expect(player.position, 'the position is frozen while off').toBeCloseTo(5, 9);

    const node = world.context.sources[0];
    expect(node.stoppedAt).toBeCloseTo(5.4, 9);
    const calls = world.context.gains[0].gain.calls;
    expect(calls.at(-3)).toEqual(['cancel', Number.NaN, 5]);
    expect(calls.at(-2)).toEqual(['set', 0.5, 5]);
    expect(calls.at(-1)).toEqual(['ramp', 0, 5.4]);

    // The fade is presentation: firing the old source's onended changes no state.
    node.onended?.();
    expect(player.state).toBe('off');
  });

  it('resumes from the frozen offset in a new source node', async () => {
    const world = fakeWorld();
    const player = mountPlayer(world, []);
    await player.play();
    world.context.currentTime = 5;
    await player.pause();
    await player.play();

    expect(player.state).toBe('playing');
    const second = world.context.sources[1];
    // start(0, offset): when 0 means "now", the offset is what carries the resume.
    expect(second.started).toEqual({ when: 0, offset: 5 });
    world.context.currentTime = 7;
    expect(player.position).toBeCloseTo(7, 9);
  });

  it('wraps the position at the loop duration', async () => {
    const world = fakeWorld();
    const player = mountPlayer(world, []);
    await player.play();
    world.context.currentTime = MANIFEST_DURATION + 3;
    expect(player.position).toBeCloseTo(3, 9);
  });

  it('aborts the fetch and leaves off when paused during loading', async () => {
    const world = fakeWorld();
    // A no-op until the manifest fetch replaces it, so the test never calls a null.
    let releaseManifest: () => void = () => undefined;
    const seenSignals: Array<AbortSignal | undefined> = [];
    world.fetchMock.mockImplementation(async (input: unknown, init?: { signal?: AbortSignal }) => {
      seenSignals.push(init?.signal);
      if (String(input).endsWith('music.json')) {
        await new Promise<void>((resolve) => {
          releaseManifest = resolve;
        });
        return { ok: true, status: 200, json: async () => manifestJson() };
      }
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(64) };
    });
    const states: MusicState[] = [];
    const player = mountPlayer(world, states);

    const loading = player.play();
    expect(player.state).toBe('loading');
    // One macrotask lets the run pass its awaits and reach the fetch, so the pause has a fetch
    // to abort rather than retiring the run before it started.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seenSignals).toHaveLength(1);
    await player.pause();
    expect(player.state).toBe('off');
    expect(seenSignals[0]?.aborted, 'the in-flight fetch was aborted').toBe(true);

    releaseManifest();
    await loading;
    expect(player.state, 'the retired run never starts music').toBe('off');
    expect(states).toEqual(['loading', 'off']);
  });
});

describe('createMusicPlayer.toggle and armed', () => {
  it('toggles between playing and off', async () => {
    const world = fakeWorld();
    const player = mountPlayer(world, []);
    expect(player.state).toBe('off');
    await player.toggle();
    expect(player.state).toBe('playing');
    await player.toggle();
    expect(player.state).toBe('off');
    await player.toggle();
    expect(player.state).toBe('playing');
  });

  it('arms without touching the engine before any gesture', async () => {
    // jsdom's navigator has no userActivation; the stub supplies one that has not been active,
    // which is the state of a fresh page in a real browser.
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: false } });
    const world = fakeWorld();
    const states: MusicState[] = [];
    const player = mountPlayer(world, states);

    await player.play();
    expect(states).toEqual(['armed']);
    expect(player.state).toBe('armed');
    expect(world.fetchMock).not.toHaveBeenCalled();
    expect(world.context.sources).toHaveLength(0);

    // A press while armed means the visitor does not want the music that was going to start.
    await player.toggle();
    expect(player.state).toBe('off');
  });
});

describe('createMusicPlayer.setDucked', () => {
  it('ramps to a quarter of the level and back', async () => {
    const world = fakeWorld();
    const player = mountPlayer(world, []);
    await player.play();

    const calls = world.context.gains[0].gain.calls;
    player.setDucked(true);
    expect(calls.at(-3)).toEqual(['cancel', Number.NaN, 0]);
    expect(calls.at(-2)).toEqual(['set', 0.5, 0]);
    expect(calls.at(-1)).toEqual(['ramp', 0.125, 0.4]);

    player.setDucked(false);
    expect(calls.at(-1)).toEqual(['ramp', 0.5, 0.4]);
  });

  it('records the duck for the next start when nothing is playing', async () => {
    const world = fakeWorld();
    const player = mountPlayer(world, []);
    player.setDucked(true);
    await player.play();
    const calls = world.context.gains[0].gain.calls;
    expect(calls[0]).toEqual(['set', 0, 0]);
    expect(calls[1], 'the fade in lands on the ducked level').toEqual(['ramp', 0.125, 0.4]);
  });
});

describe('createMusicPlayer.dispose', () => {
  it('stops the source at once, with no fade and no onended', async () => {
    const world = fakeWorld();
    const player = mountPlayer(world, []);
    await player.play();
    world.context.currentTime = 6;
    player.dispose();
    // stop() with no argument stops now; the fake records that as time 0.
    expect(world.context.sources[0].stoppedAt).toBe(0);
    expect(world.context.sources[0].onended).toBeNull();
  });
});
