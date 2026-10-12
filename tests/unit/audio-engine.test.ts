import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAudioEngine } from '../../src/audio/engine';

// The engine runs against a stubbed AudioContext constructor, the stand-in for the constructor a
// browser exposes to the page. The fake keeps the state machine the engine relies on: a context
// is born suspended, resume moves it and fires onstatechange, close lands on closed. A unit test
// has no real gesture to offer, so the gesture discipline stays with the callers, where the mount
// and player tests already pin it; these tests pin what the engine itself promises once unlock()
// runs inside one.

class FakeGain {
  connectedTo: unknown[] = [];
  connect(node: unknown): unknown {
    this.connectedTo.push(node);
    return node;
  }
}

class FakeAudioContext {
  static created: FakeAudioContext[] = [];
  /** Where the next context's resume() lands: a browser property, so it is set before creation. */
  static nextResumesTo: AudioContextState = 'running';

  state: AudioContextState = 'suspended';
  onstatechange: (() => void) | null = null;
  readonly destination = { name: 'destination' };
  readonly gains: FakeGain[] = [];
  resumesTo: AudioContextState;
  resumeError: Error | null = null;
  resumeCount = 0;
  closeCount = 0;
  closed = false;

  constructor() {
    this.resumesTo = FakeAudioContext.nextResumesTo;
    FakeAudioContext.created.push(this);
  }

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  async resume(): Promise<void> {
    this.resumeCount += 1;
    if (this.resumeError !== null) {
      throw this.resumeError;
    }
    this.moveTo(this.resumesTo);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.closed = true;
    this.moveTo('closed');
  }

  /** A browser moves the state and then fires statechange; a repeat of one state fires not. */
  moveTo(state: AudioContextState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.onstatechange?.();
  }
}

function lastContext(): FakeAudioContext {
  const found = FakeAudioContext.created.at(-1);
  if (found === undefined) {
    throw new Error('no AudioContext was created');
  }
  return found;
}

beforeEach(() => {
  FakeAudioContext.created = [];
  FakeAudioContext.nextResumesTo = 'running';
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createAudioEngine before the first unlock', () => {
  it('creates no context, holds no buses and reports absent', () => {
    const engine = createAudioEngine();
    expect(engine.buses).toBeNull();
    expect(FakeAudioContext.created).toHaveLength(0);
    const seen: Array<AudioContextState | 'absent'> = [];
    engine.onStateChange((state) => seen.push(state));
    expect(seen).toEqual(['absent']);
  });
});

describe('createAudioEngine.unlock', () => {
  it('creates exactly one context on the first unlock and wires its buses', async () => {
    const engine = createAudioEngine();
    const buses = await engine.unlock();

    expect(FakeAudioContext.created).toHaveLength(1);
    const context = lastContext();
    expect(buses).not.toBeNull();
    expect(engine.buses).toBe(buses);
    expect(buses?.context).toBe(context);
    expect(buses?.music).toBe(context.gains[0]);
    expect(context.gains[0].connectedTo).toEqual([context.destination]);
    // The first unlock resumes as well: a context is born suspended.
    expect(context.resumeCount).toBe(1);
    expect(buses?.context.state).toBe('running');
  });

  it('creates no second context on a second unlock and resumes the one there is', async () => {
    const engine = createAudioEngine();
    const first = await engine.unlock();
    const context = lastContext();

    const second = await engine.unlock();

    expect(FakeAudioContext.created).toHaveLength(1);
    expect(second).toBe(first);
    expect(engine.buses).toBe(first);
    expect(context.resumeCount).toBe(2);
  });

  it('resolves null when the browser keeps the context suspended', async () => {
    FakeAudioContext.nextResumesTo = 'suspended';
    const engine = createAudioEngine();

    const result = await engine.unlock();

    expect(result).toBeNull();
    expect(FakeAudioContext.created).toHaveLength(1);
    expect(engine.buses?.context.state).toBe('suspended');
  });

  it('resolves null and keeps buses null when the browser has no audio at all', async () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('no audio device');
        }
      },
    );
    const engine = createAudioEngine();

    const result = await engine.unlock();

    expect(result).toBeNull();
    expect(engine.buses).toBeNull();
  });

  it('creates no second context when a later resume is rejected', async () => {
    const engine = createAudioEngine();
    await engine.unlock();
    const context = lastContext();
    // iOS after a phone call: the context sits interrupted and the next gesture's resume decides.
    context.moveTo('interrupted');
    context.resumeError = new Error('resume needs a gesture');

    const result = await engine.unlock();

    expect(result).toBeNull();
    expect(FakeAudioContext.created).toHaveLength(1);
    expect(engine.buses?.context.state).toBe('interrupted');
  });
});

describe('createAudioEngine.onStateChange', () => {
  it('reports absent, then the context state at creation and on every change', async () => {
    const engine = createAudioEngine();
    const seen: Array<AudioContextState | 'absent'> = [];
    engine.onStateChange((state) => seen.push(state));
    expect(seen).toEqual(['absent']);

    await engine.unlock();
    expect(seen).toEqual(['absent', 'suspended', 'running']);

    lastContext().moveTo('suspended');
    expect(seen).toEqual(['absent', 'suspended', 'running', 'suspended']);
  });

  it('stops reporting once the returned unsubscribe has run', async () => {
    const engine = createAudioEngine();
    const seen: Array<AudioContextState | 'absent'> = [];
    const unsubscribe = engine.onStateChange((state) => seen.push(state));

    unsubscribe();
    await engine.unlock();
    expect(seen).toEqual(['absent']);
  });

  it('reports to every listener, including one that subscribes late', async () => {
    const engine = createAudioEngine();
    const first: Array<AudioContextState | 'absent'> = [];
    const second: Array<AudioContextState | 'absent'> = [];
    engine.onStateChange((state) => first.push(state));

    await engine.unlock();
    engine.onStateChange((state) => second.push(state));
    expect(second).toEqual(['running']);

    lastContext().moveTo('interrupted');
    expect(first).toEqual(['absent', 'suspended', 'running', 'interrupted']);
    expect(second).toEqual(['running', 'interrupted']);
  });
});

describe('createAudioEngine.dispose', () => {
  it('closes the context and reads as absent afterwards', async () => {
    const engine = createAudioEngine();
    await engine.unlock();
    const context = lastContext();

    engine.dispose();

    expect(context.closed).toBe(true);
    expect(engine.buses).toBeNull();
    const seen: Array<AudioContextState | 'absent'> = [];
    engine.onStateChange((state) => seen.push(state));
    expect(seen).toEqual(['absent']);
  });

  it('is safe without a context and when called twice', async () => {
    const engine = createAudioEngine();
    expect(() => engine.dispose()).not.toThrow();

    await engine.unlock();
    const context = lastContext();
    engine.dispose();
    engine.dispose();
    expect(context.closeCount).toBe(1);
  });
});
