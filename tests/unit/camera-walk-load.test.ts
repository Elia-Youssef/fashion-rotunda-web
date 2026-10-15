// @vitest-environment jsdom
import { PerspectiveCamera } from 'three';
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
  let partial: WalkSession | null = null;
  const factory = vi.fn((options: Parameters<typeof readyWalkSession>[0]) => {
    partial = readyWalkSession(options);
    vi.spyOn(partial, 'dispose');
    partial.loadCollision = vi.fn(() => { enteredParse.resolve(); return parsing.promise; });
    return partial;
  });
  const importer = vi.fn(() => imported.promise);
  const fetchCollision = vi.fn<typeof fetch>(() => fetched.promise);
  const loader = createWalkLoad({
    camera: new PerspectiveCamera(), canvas: document.createElement('canvas'),
    isTouch: false, now: () => 0, onChange: vi.fn(), collisionUrl: '/content/collision.glb',
    importer, fetchCollision,
  });
  owners.push(loader);
  const response = { ok: true, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
  async function reachParse() {
    imported.resolve({ createWalkSession: factory });
    fetched.resolve(response);
    await enteredParse.promise;
    return partial!;
  }
  return { loader, imported, fetched, parsing, factory, importer, fetchCollision, reachParse, response };
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
});
