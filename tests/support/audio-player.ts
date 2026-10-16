import { expect, vi } from 'vitest';

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

export const MANIFEST_DURATION = 105.65;

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

export interface FakeWorld {
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

export function manifestJson(): TestManifest {
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

export function mountPlayer(world: FakeWorld, states: MusicState[], trackId: string | null = null) {
  return createMusicPlayer({
    engine: world.engine,
    baseUrl: '/content/music',
    trackId,
    level: 0.5,
    fadeMs: 400,
    onStateChange: (state) => states.push(state),
  });
}

export function fakeWorld(): FakeWorld {
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

export interface ManifestResponse {
  ok: boolean;
  status: number;
  json: () => Promise<TestManifest>;
}

export interface FileResponse {
  ok: boolean;
  status: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

/**
 * A fetch double for the retirement cases: the first request per URL parks until the test opens
 * it, later requests answer at once, and every request records the abort signal it carried.
 */
export function parkedFetch(world: FakeWorld): {
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
