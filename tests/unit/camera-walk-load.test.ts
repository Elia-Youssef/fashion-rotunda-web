// @vitest-environment jsdom
import { BoxGeometry, Group, Mesh, PerspectiveCamera } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { setImmediate } from 'node:timers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WalkLoader, WalkSession } from '../../src/camera/contracts';
import { createWalkLoad } from '../../src/camera/walk-load';
import { readyWalkSession } from '../support/camera-walk-fixtures';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function completeFactory(options: Parameters<typeof readyWalkSession>[0]): WalkSession {
  const owner = readyWalkSession(options);
  owner.loadCollision = async () => {};
  return owner;
}

const owners: WalkLoader[] = [];
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.dispose());
  vi.restoreAllMocks();
});

function make() {
  const imported = deferred<{ createWalkSession: typeof readyWalkSession }>();
  const fetched = deferred<Response>();
  const parsing = deferred<void>();
  const enteredParse = deferred<void>();
  const bytes = new ArrayBuffer(0);
  let partial: WalkSession | null = null;
  let parseArgs: [ArrayBuffer, AbortSignal] | null = null;
  const factory = vi.fn((options: Parameters<typeof readyWalkSession>[0]) => {
    partial = readyWalkSession(options);
    vi.spyOn(partial, 'dispose');
    partial.loadCollision = vi.fn((data: ArrayBuffer, signal: AbortSignal) => {
      parseArgs = [data, signal];
      enteredParse.resolve();
      return parsing.promise;
    });
    return partial;
  });
  const importer = vi.fn(() => imported.promise);
  const fetchCollision = vi.fn<typeof fetch>(() => fetched.promise);
  const loadOptions = {
    camera: new PerspectiveCamera(), canvas: document.createElement('canvas'),
    isTouch: false, now: () => 0, onChange: vi.fn(), collisionUrl: '/content/collision.glb',
    importer, fetchCollision,
  };
  const loader = createWalkLoad(loadOptions);
  owners.push(loader);
  const response = { ok: true, arrayBuffer: async () => bytes } as Response;
  async function reachParse() {
    imported.resolve({ createWalkSession: factory });
    fetched.resolve(response);
    await enteredParse.promise;
    return partial!;
  }
  return {
    loader, imported, fetched, parsing, factory, importer, fetchCollision, reachParse, response,
    bytes, loadOptions, parseArgs: () => parseArgs!,
  };
}

describe('createWalkLoad', () => {
  it('shares one pending attempt and caches only a collision-ready owner', async () => {
    const f = make();
    const first = f.loader.ensureReady();
    expect(f.loader.ensureReady()).toBe(first);
    expect(f.loader.state).toBe('loading');
    expect(f.loader.session).toBeNull();
    const partial = await f.reachParse();
    expect(f.loader.session).toBeNull();
    f.parsing.resolve();
    expect(await first).toBe(partial);
    expect(f.loader.state).toBe('ready');
    expect(await f.loader.ensureReady()).toBe(partial);
    expect(f.importer).toHaveBeenCalledOnce();
    expect(f.fetchCollision).toHaveBeenCalledOnce();
    expect(f.factory).toHaveBeenCalledOnce();
  });

  it.each(['import', 'http', 'body', 'construction', 'parse'] as const)(
    'rejects %s failure and permits an explicit successful retry', async (stage) => {
      const f = make();
      const loading = f.loader.ensureReady();
      const rejected = expect(loading).rejects.toThrow('broken');
      const failure = new Error('broken');
      if (stage === 'import') f.imported.reject(failure);
      else f.imported.resolve({ createWalkSession: stage === 'construction'
        ? () => { throw failure; } : f.factory });
      if (stage === 'http') f.fetched.reject(failure);
      else if (stage === 'body') f.fetched.resolve({
        ok: true, arrayBuffer: async () => { throw failure; },
      } as unknown as Response);
      else f.fetched.resolve(f.response);
      if (stage === 'parse') { await f.reachParse(); f.parsing.reject(failure); }
      await rejected;
      expect(f.loader.state).toBe('error');
      expect(f.loader.session).toBeNull();
      expect(f.fetchCollision.mock.calls[0][1]?.signal?.aborted).toBe(true);
      f.importer.mockResolvedValue({ createWalkSession: completeFactory });
      f.fetchCollision.mockResolvedValue(f.response);
      expect(await f.loader.ensureReady()).not.toBeNull();
      expect(f.loader.state).toBe('ready');
      expect(f.fetchCollision).toHaveBeenCalledTimes(2);
    },
  );

  it('rejects a non-success HTTP status before parsing', async () => {
    const f = make();
    const result = f.loader.ensureReady();
    const rejected = expect(result).rejects.toThrow('collision mesh answered 503');
    f.imported.resolve({ createWalkSession: f.factory });
    f.fetched.resolve({ ok: false, status: 503 } as Response);
    await rejected;
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.loader.state).toBe('error');
  });

  it.each(['import', 'fetch', 'body', 'parse', 'ready'] as const)(
    'settles disposal during %s and prevents late resource publication', async (stage) => {
      const f = make();
      const notify = vi.fn();
      f.loader.onStateChange(notify);
      const result = f.loader.ensureReady();
      let partial: WalkSession | null = null;
      const body = deferred<ArrayBuffer>();
      if (stage === 'parse' || stage === 'ready') partial = await f.reachParse();
      else if (stage === 'fetch' || stage === 'body') {
        f.imported.resolve({ createWalkSession: f.factory });
        if (stage === 'body') f.fetched.resolve({ ok: true, arrayBuffer: () => body.promise } as Response);
        await Promise.resolve();
      }
      if (stage === 'ready') { f.parsing.resolve(); await result; }
      f.loader.dispose();
      f.loader.dispose();
      if (stage !== 'ready') expect(await result).toBeNull();
      notify.mockClear();
      f.imported.resolve({ createWalkSession: f.factory });
      f.fetched.resolve(f.response);
      body.resolve(new ArrayBuffer(0));
      f.parsing.resolve();
      // A check-phase checkpoint drains all jobs released by these controlled promises.
      // It has no duration and does not wait for a clock, timer or network response.
      await Promise.all([f.imported.promise, f.fetched.promise, f.parsing.promise]);
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(f.loader.state).toBe('disposed');
      expect(f.loader.session).toBeNull();
      expect(notify).not.toHaveBeenCalled();
      if (partial) expect(partial.dispose).toHaveBeenCalled();
      else expect(f.factory).not.toHaveBeenCalled();
      expect(await f.loader.ensureReady()).toBeNull();
    },
  );

  it('cancels parsing, starts a distinct attempt and rejects the old result as an owner', async () => {
    const f = make();
    const old = f.loader.ensureReady();
    const partial = await f.reachParse();
    f.loader.cancel();
    expect(await old).toBeNull();
    expect(partial.dispose).toHaveBeenCalled();
    f.importer.mockResolvedValue({ createWalkSession: completeFactory });
    f.fetchCollision.mockResolvedValue(f.response);
    const next = await f.loader.ensureReady();
    f.parsing.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.loader.session).toBe(next);
    expect(next).not.toBe(partial);
    expect(f.loader.state).toBe('ready');
  });

  it('notifies state listeners of every publish and stops a removed listener', async () => {
    const f = make();
    const seen: string[] = [];
    const removed = vi.fn();
    const stop = f.loader.onStateChange(removed);
    f.loader.onStateChange(() => seen.push(f.loader.state));
    stop();
    const loading = f.loader.ensureReady();
    expect(seen).toEqual(['loading']);
    const partial = await f.reachParse();
    f.parsing.resolve();
    expect(await loading).toBe(partial);
    expect(seen).toEqual(['loading', 'ready']);
    // The cached session answers without a new publish.
    expect(await f.loader.ensureReady()).toBe(partial);
    expect(seen).toEqual(['loading', 'ready']);
    expect(removed).not.toHaveBeenCalled();
  });

  it('publishes idle when a loading attempt is cancelled', async () => {
    const f = make();
    const seen: string[] = [];
    f.loader.onStateChange(() => seen.push(f.loader.state));
    const loading = f.loader.ensureReady();
    f.loader.cancel();
    expect(await loading).toBeNull();
    expect(f.loader.state).toBe('idle');
    expect(seen).toEqual(['loading', 'idle']);
  });

  it('keeps an error state when cancel arrives after a failure', async () => {
    const f = make();
    const rejected = expect(f.loader.ensureReady()).rejects.toThrow('boom');
    f.imported.reject(new Error('boom'));
    await rejected;
    expect(f.loader.state).toBe('error');
    f.loader.cancel();
    expect(f.loader.state).toBe('error');
  });

  it('forwards url, bytes, options and the attempt signal, which cancel aborts', async () => {
    const f = make();
    void f.loader.ensureReady();
    const partial = await f.reachParse();
    expect(f.fetchCollision.mock.calls[0][0]).toBe('/content/collision.glb');
    const request = f.fetchCollision.mock.calls[0][1] as RequestInit;
    expect(request.signal).toBeInstanceOf(AbortSignal);
    const [data, signal] = f.parseArgs();
    expect(data).toBe(f.bytes);
    expect(signal).toBe(request.signal);
    expect(signal.aborted).toBe(false);
    expect(f.factory.mock.calls[0][0]).toBe(f.loadOptions);
    f.loader.cancel();
    expect(signal.aborted).toBe(true);
    expect(partial.dispose).toHaveBeenCalled();
  });

  it('disposes the session it built when the collision parse fails', async () => {
    const f = make();
    const loading = f.loader.ensureReady();
    const partial = await f.reachParse();
    const rejected = expect(loading).rejects.toThrow('boom');
    f.parsing.reject(new Error('boom'));
    await rejected;
    expect(partial.dispose).toHaveBeenCalled();
    expect(f.loader.session).toBeNull();
    expect(f.loader.state).toBe('error');
  });

  it('keeps a cancelled attempt idle when its late parse then fails', async () => {
    const f = make();
    const seen: string[] = [];
    f.loader.onStateChange(() => seen.push(f.loader.state));
    const loading = f.loader.ensureReady();
    const partial = await f.reachParse();
    f.loader.cancel();
    await loading;
    f.parsing.reject(new Error('boom'));
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(f.loader.state).toBe('idle');
    expect(seen).toEqual(['loading', 'idle']);
    expect(partial.dispose).toHaveBeenCalled();
  });

  it('disposes the pending session synchronously when the loader is disposed', async () => {
    const f = make();
    void f.loader.ensureReady();
    const partial = await f.reachParse();
    f.loader.dispose();
    expect(partial.dispose).toHaveBeenCalled();
    expect(f.loader.session).toBeNull();
  });

  it('turns a synchronously throwing importer into a rejection', async () => {
    const f = make();
    f.importer.mockImplementation(() => { throw new Error('boom'); });
    const rejected = expect(f.loader.ensureReady()).rejects.toThrow('boom');
    await rejected;
    expect(f.loader.state).toBe('error');
    expect(f.fetchCollision).toHaveBeenCalledOnce();
  });

  it('falls back to the bundled session factory and the page fetch', async () => {
    const parser = vi.spyOn(GLTFLoader.prototype, 'parse').mockImplementationOnce(
      (_data, _path, done) => {
        const scene = new Group();
        scene.add(new Mesh(new BoxGeometry(20, 4, 0.4).translate(0, 2, 4)));
        done({ scene } as GLTF);
      },
    );
    const pageFetch = vi.fn<typeof fetch>(async () => ({
      ok: true, arrayBuffer: async () => new ArrayBuffer(0),
    } as Response));
    vi.stubGlobal('fetch', pageFetch);
    try {
      const loader = createWalkLoad({
        camera: new PerspectiveCamera(), canvas: document.createElement('canvas'),
        isTouch: false, now: () => 0, onChange: vi.fn(), collisionUrl: '/content/collision.glb',
      });
      owners.push(loader);
      const session = await loader.ensureReady();
      expect(session).toBe(loader.session);
      expect(loader.state).toBe('ready');
      expect(pageFetch).toHaveBeenCalledWith('/content/collision.glb', expect.objectContaining({
        signal: expect.any(AbortSignal),
      }));
    } finally {
      parser.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
