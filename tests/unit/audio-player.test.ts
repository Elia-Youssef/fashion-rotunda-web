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
  vi.resetModules();
});

interface ManifestResponse {
  ok: boolean;
  status: number;
  json: () => Promise<TestManifest>;
}

interface FileResponse {
  ok: boolean;
  status: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

/**
 * A fetch double for the retirement cases: the first request per URL parks until the test opens
 * it, later requests answer at once, and every request records the abort signal it carried.
 */
function parkedFetch(world: FakeWorld): {
  signals: Array<AbortSignal | undefined>;
  openManifest(): void;
  openFile(): void;
  failManifest(error: unknown): void;
} {
  const signals: Array<AbortSignal | undefined> = [];
  let manifestParked = false;
  let fileParked = false;
  let openManifest: () => void = () => undefined;
  let openFile: () => void = () => undefined;
  let failManifest: (error: unknown) => void = () => undefined;
  world.fetchMock.mockImplementation((input: unknown, init?: { signal?: AbortSignal }) => {
    signals.push(init?.signal);
    if (String(input).endsWith('music.json')) {
      if (manifestParked) {
        return Promise.resolve({ ok: true, status: 200, json: async () => manifestJson() });
      }
      manifestParked = true;
      return new Promise<ManifestResponse>((resolve, reject) => {
        openManifest = () => resolve({ ok: true, status: 200, json: async () => manifestJson() });
        failManifest = reject;
      });
    }
    if (fileParked) {
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(64),
      });
    }
    fileParked = true;
    return new Promise<FileResponse>((resolve) => {
      openFile = () => resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(64) });
    });
  });
  return {
    signals,
    openManifest: () => openManifest(),
    openFile: () => openFile(),
    failManifest: (error: unknown) => failManifest(error),
  };
}

it('fetches both the music list and the selected format through the configured content resolver', async () => {
  const origin = 'https://static.example.invalid';
  const files = ['music/music.json', 'music/music-01.ogg',
    'basis/basis_transcoder.js', 'basis/basis_transcoder.wasm'].map((path, index) => {
    const sha256 = index.toString(16).padStart(64, '0');
    const key = path.startsWith('basis/') ? `content/${path}` : `content/${sha256}.${path.split('.').pop()}`;
    return { path, sha256, bytes: 100, key, url: `${origin}/${key}` };
  });
  vi.stubGlobal('__CONTENT_ORIGIN__', origin);
  vi.stubGlobal('__CONTENT_MANIFEST__', { origin, files });
  vi.resetModules();
  const { createMusicPlayer: createRemotePlayer } = await import('../../src/audio/music');
  const world = fakeWorld();
  world.fetchMock.mockImplementation(async (input: unknown) => {
    if (input === files[0].url) return { ok: true, status: 200, json: async () => manifestJson() };
    if (input === files[1].url) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(64) };
    throw new Error('unexpected music request: ' + String(input));
  });
  const player = createRemotePlayer({ engine: world.engine, baseUrl: '/content/music', trackId: null,
    level: 0.5, fadeMs: 400, onStateChange: () => {} });
  try {
    await player.play();
    expect(player.state).toBe('playing');
    expect(world.fetchMock.mock.calls.map(([url]) => url)).toEqual([files[0].url, files[1].url]);
  } finally { player.dispose(); }
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
    // The detail is null: the switch draws its own fixed text for the state, and the raw cause
    // stays in the console under the [archviz] prefix.
    expect(states.at(-1)?.[1]).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe(
      '[archviz] music unavailable: The music list could not be fetched (status 500).',
    );

    failManifest = false;
    await player.play();
    expect(player.state).toBe('playing');
    // The failed attempt asked for the manifest and nothing else; the retry asked for the file too.
    expect(world.fetchMock).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('reports every rejection shape the same way: null detail, one warned cause', async () => {
    const world = fakeWorld();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A rejection that is not an Error takes the same path as one that is.
    world.fetchMock.mockRejectedValue('boom');
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
    expect(states).toEqual([['loading', null], ['error', null]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe('[archviz] music unavailable: boom');
    warn.mockRestore();
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

  it('falls back to the first track when the default names none', async () => {
    const world = fakeWorld();
    const orphanDefault = manifestJson();
    orphanDefault.default = 'music-99';
    world.fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).endsWith('music.json')) {
        return { ok: true, status: 200, json: async () => orphanDefault };
      }
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(64) };
    });
    const player = mountPlayer(world, []);
    await player.play();
    expect(player.state).toBe('playing');
    expect(String(world.fetchMock.mock.calls[1][0])).toContain('music-01.ogg');
    expect(world.context.sources[0].loopEnd).toBe(MANIFEST_DURATION);
  });

  it('reports an empty track list as an error, not a crash', async () => {
    const world = fakeWorld();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const emptyList = manifestJson();
    emptyList.tracks = [];
    world.fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).endsWith('music.json')) {
        return { ok: true, status: 200, json: async () => emptyList };
      }
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(64) };
    });
    const player = mountPlayer(world, []);
    await player.play();
    expect(player.state).toBe('error');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe(
      '[archviz] music unavailable: The music list has no track to play.',
    );
    warn.mockRestore();
  });

  it('reports a browser that plays neither listed format', async () => {
    const world = fakeWorld();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unplayable = manifestJson();
    unplayable.tracks[0].sources = [];
    world.fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).endsWith('music.json')) {
        return { ok: true, status: 200, json: async () => unplayable };
      }
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(64) };
    });
    const player = mountPlayer(world, []);
    await player.play();
    expect(player.state).toBe('error');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe(
      '[archviz] music unavailable: This browser plays neither music format.',
    );
    // The format question is answered before any file is requested.
    expect(world.fetchMock).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('maps a failed file fetch to error and names its status', async () => {
    const world = fakeWorld();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    world.fetchMock.mockImplementation(async (input: unknown) => {
      if (String(input).endsWith('music.json')) {
        return { ok: true, status: 200, json: async () => manifestJson() };
      }
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(64) };
    });
    const player = mountPlayer(world, []);
    await player.play();
    expect(player.state).toBe('error');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe(
      '[archviz] music unavailable: The music file could not be fetched (status 404).',
    );
    expect(world.context.decodeCount, 'nothing is decoded from a failed response').toBe(0);
    warn.mockRestore();
  });

  it('reports a refused context as an error with its own words', async () => {
    // The interruption recovery reaches this through the mount; here the refusal is direct. The
    // words matter: "would not start" is the browser refusing, and the switch's retry reads the
    // same console line a developer reads.
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: true } });
    const world = fakeWorld();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const states: Array<[MusicState, string | null]> = [];
    const engine: AudioEngine = {
      buses: null,
      unlock: async () => null,
      onStateChange: () => () => undefined,
      dispose: () => undefined,
    };
    const player = createMusicPlayer({
      engine,
      baseUrl: '/content/music',
      trackId: null,
      level: 0.5,
      fadeMs: 400,
      onStateChange: (state, detail) => states.push([state, detail]),
    });

    await player.play();
    expect(player.state).toBe('error');
    expect(states).toEqual([['loading', null], ['error', null]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toBe(
      '[archviz] music unavailable: The audio context would not start.',
    );
    expect(world.fetchMock, 'a refused context asks for nothing').not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ignores a second play while playing', async () => {
    const world = fakeWorld();
    const states: MusicState[] = [];
    const player = mountPlayer(world, states);
    await player.play();

    await player.play();
    expect(player.state).toBe('playing');
    // One source, no second load, no repeated state: the loop is already running.
    expect(world.context.sources).toHaveLength(1);
    expect(states).toEqual(['loading', 'playing']);
  });

  it('ignores a second play while loading', async () => {
    const world = fakeWorld();
    const gate = parkedFetch(world);
    const states: MusicState[] = [];
    const player = mountPlayer(world, states);

    const first = player.play();
    const second = player.play();
    // One macrotask: the first run passes unlock and parks at the manifest request.
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.openManifest();
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.openFile();
    await Promise.all([first, second]);

    expect(player.state).toBe('playing');
    expect(states).toEqual(['loading', 'playing']);
    expect(world.fetchMock).toHaveBeenCalledTimes(2);
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

  it('reports nothing new for a pause while already off', async () => {
    const world = fakeWorld();
    const states: MusicState[] = [];
    const player = mountPlayer(world, states);
    await player.play();
    await player.pause();

    await player.pause();
    // Off is a settled answer: repeating the question publishes no second state.
    expect(states).toEqual(['loading', 'playing', 'off']);
  });
});

describe('createMusicPlayer run retirement', () => {
  it('keeps a failure that lands after retirement silent', async () => {
    // A load retired by pause() can still hear its fetch fail a moment later; the visitor has
    // already read "off", so the late failure neither warns nor flips the state back.
    const world = fakeWorld();
    const gate = parkedFetch(world);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const states: Array<[MusicState, string | null]> = [];
    const player = createMusicPlayer({
      engine: world.engine,
      baseUrl: '/content/music',
      trackId: null,
      level: 0.5,
      fadeMs: 400,
      onStateChange: (state, detail) => states.push([state, detail]),
    });

    const loading = player.play();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await player.pause();
    gate.failManifest(new Error('the network went away'));
    await loading;

    expect(player.state).toBe('off');
    expect(states).toEqual([['loading', null], ['off', null]]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('shares one manifest request across a retired load and its retry', async () => {
    // Pause during the manifest fetch retires the run but leaves its request in flight; the
    // retry must ride the same request rather than issue a second one for the same list.
    const world = fakeWorld();
    const gate = parkedFetch(world);
    const player = mountPlayer(world, []);

    const first = player.play();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await player.pause();
    const second = player.play();
    gate.openManifest();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The retired run continues into its own file request and parks there; the retry rides the
    // same manifest and runs ahead. Both requests have to be released for the runs to settle.
    gate.openFile();
    await Promise.all([first, second]);

    expect(player.state).toBe('playing');
    const manifestRequests = world.fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.endsWith('music.json'));
    expect(manifestRequests).toHaveLength(1);
  });

  it('lets only the run that owns the controller clear it', async () => {
    // A retired run's finally block must not drop the controller its successor installed, or
    // the next pause could not abort the request that successor still has in flight. Every
    // file request parks separately here, so each run can be moved on its own.
    const world = fakeWorld();
    const fileSignals: Array<AbortSignal | undefined> = [];
    const openFile: Array<() => void> = [];
    let openManifest: () => void = () => undefined;
    world.fetchMock.mockImplementation((input: unknown, init?: { signal?: AbortSignal }) => {
      if (String(input).endsWith('music.json')) {
        return new Promise<ManifestResponse>((resolve) => {
          openManifest = () => resolve({ ok: true, status: 200, json: async () => manifestJson() });
        });
      }
      fileSignals.push(init?.signal);
      return new Promise<FileResponse>((resolve) => {
        openFile.push(() => resolve({
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(64),
        }));
      });
    });
    const player = mountPlayer(world, []);

    const first = player.play();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await player.pause();
    const second = player.play();
    openManifest();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Both runs are now parked at their own file request; the second owns the controller.
    openFile[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The first run has returned by now; its finally block must have left the controller be.
    await player.pause();

    expect(fileSignals[1]?.aborted, 'the live run\'s file request was aborted').toBe(true);

    openFile[1]();
    await Promise.all([first, second]);
    expect(player.state).toBe('off');
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

  it('stops the load when toggled while loading', async () => {
    const world = fakeWorld();
    const gate = parkedFetch(world);
    const states: MusicState[] = [];
    const player = mountPlayer(world, states);

    const loading = player.play();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await player.toggle();

    expect(player.state).toBe('off');
    expect(gate.signals[0]?.aborted, 'the in-flight manifest request was aborted').toBe(true);

    // The retired run still walks its own file request to the end before it notices; both
    // gates are opened so it can settle without ever starting music.
    gate.openManifest();
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.openFile();
    await loading;
    expect(states).toEqual(['loading', 'off']);
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

  it('aborts the in-flight fetch when disposed during a load', async () => {
    const world = fakeWorld();
    const gate = parkedFetch(world);
    const player = mountPlayer(world, []);

    const loading = player.play();
    await new Promise((resolve) => setTimeout(resolve, 0));
    player.dispose();

    expect(gate.signals[0]?.aborted, 'dispose aborted the request it retires').toBe(true);

    gate.openManifest();
    await new Promise((resolve) => setTimeout(resolve, 0));
    gate.openFile();
    await loading;
    expect(world.context.sources).toHaveLength(0);
  });
});
