// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMusicPlayer } from '../../src/audio/music';
import type { MusicState } from '../../src/audio/music';
import { fakeWorld, manifestJson, mountPlayer, parkedFetch } from '../support/audio-player';
import type { FileResponse, ManifestResponse } from '../support/audio-player';

// A load run superseded mid-flight: its late failures stay silent, its manifest request is
// shared with the retry, and only the run that owns the abort controller may clear it.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
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
