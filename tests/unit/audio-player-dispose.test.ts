// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fakeWorld, mountPlayer, parkedFetch } from '../support/audio-player';

// dispose(): the source stops at once with no fade, and a load in flight is aborted.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
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
