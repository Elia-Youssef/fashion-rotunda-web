// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MusicState } from '../../src/audio/music';
import { MANIFEST_DURATION, fakeWorld, manifestJson, mountPlayer } from '../support/audio-player';

// pause() and position: the fade-out and the frozen position, the resume offset in a new
// source node, the loop wrap, and a pause that aborts a load still in flight.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
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
