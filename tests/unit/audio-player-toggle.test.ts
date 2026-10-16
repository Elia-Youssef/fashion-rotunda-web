// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MusicState } from '../../src/audio/music';
import { fakeWorld, mountPlayer, parkedFetch } from '../support/audio-player';

// toggle() and the armed state: the switch between playing and off, arming before the
// visitor's first gesture, and a toggle that stops a load still in flight.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
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
