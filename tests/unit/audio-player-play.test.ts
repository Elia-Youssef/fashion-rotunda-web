// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AudioEngine } from '../../src/audio/engine';
import { createMusicPlayer } from '../../src/audio/music';
import type { MusicState } from '../../src/audio/music';
import {
  MANIFEST_DURATION,
  fakeWorld,
  manifestJson,
  mountPlayer,
  parkedFetch,
} from '../support/audio-player';

// Loading and starting a track: the fetch, decode and format choice behind play(), how each
// failure maps to the error state, and the content manifest that resolves the remote URLs.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

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
