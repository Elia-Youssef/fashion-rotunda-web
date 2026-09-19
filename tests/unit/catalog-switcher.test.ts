import { describe, expect, it } from 'vitest';
import { createSwitcher } from '../../src/catalog/switcher';
import type { Switcher } from '../../src/catalog/switcher';

// Every load is a deferred promise resolved by hand, so the tests decide which request finishes
// first. That is the only way to reproduce the case the switcher exists for: a slow first request
// that lands after a fast second one.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

function deferred<T>(): Deferred<T> {
  const slots: { resolve?: (value: T) => void; reject?: (error: Error) => void } = {};
  const promise = new Promise<T>((resolve, reject) => {
    slots.resolve = resolve;
    slots.reject = reject;
  });
  // The executor runs synchronously, so both slots are filled by the time the constructor returns.
  const { resolve, reject } = slots;
  if (resolve === undefined || reject === undefined) {
    throw new Error('the promise executor did not run synchronously');
  }
  return { promise, resolve, reject };
}

/** A stand-in look: an id and nothing else, so an identity comparison is all a test needs. */
interface FakeLook {
  id: string;
}

interface Harness {
  switcher: Switcher;
  /** One deferred per load call, in call order. */
  loads: { id: string; signal: AbortSignal; deferred: Deferred<FakeLook> }[];
  ready: { id: string; loaded: FakeLook }[];
  disposed: FakeLook[];
}

function harness(): Harness {
  const loads: Harness['loads'] = [];
  const ready: Harness['ready'] = [];
  const disposed: FakeLook[] = [];
  const switcher = createSwitcher<FakeLook>({
    load: (id, signal) => {
      const entry = { id, signal, deferred: deferred<FakeLook>() };
      loads.push(entry);
      return entry.deferred.promise;
    },
    dispose: (loaded) => {
      disposed.push(loaded);
    },
    onReady: (id, loaded) => {
      ready.push({ id, loaded });
    },
  });
  return { switcher, loads, ready, disposed };
}

describe('createSwitcher', () => {
  it('keeps the second request when the first one resolves last', async () => {
    const { switcher, loads, ready, disposed } = harness();
    const first = switcher.request('wallis-dress');
    const second = switcher.request('zoot-suit');
    expect(loads.map((entry) => entry.id)).toEqual(['wallis-dress', 'zoot-suit']);
    expect(switcher.pending).toBe('zoot-suit');

    const zoot: FakeLook = { id: 'zoot-suit' };
    const wallis: FakeLook = { id: 'wallis-dress' };
    loads[1].deferred.resolve(zoot);
    await second;
    loads[0].deferred.resolve(wallis);
    await first;

    expect(ready).toEqual([{ id: 'zoot-suit', loaded: zoot }]);
    expect(disposed).toEqual([wallis]);
    expect(switcher.current).toBe('zoot-suit');
    expect(switcher.pending).toBeNull();
  });

  it('aborts the signal of the request it supersedes, and only that one', async () => {
    const { switcher, loads } = harness();
    const first = switcher.request('wallis-dress');
    const second = switcher.request('zoot-suit');
    expect(loads[0].signal.aborted).toBe(true);
    expect(loads[1].signal.aborted).toBe(false);

    loads[1].deferred.resolve({ id: 'zoot-suit' });
    loads[0].deferred.reject(new Error('aborted'));
    await Promise.all([first, second]);
  });

  it('resolves a superseded request whose load then fails, instead of rejecting it', async () => {
    const { switcher, loads, ready } = harness();
    const first = switcher.request('wallis-dress');
    const second = switcher.request('zoot-suit');
    loads[1].deferred.resolve({ id: 'zoot-suit' });
    await second;
    loads[0].deferred.reject(new Error('the fetch was aborted'));

    await expect(first).resolves.toBeUndefined();
    expect(ready).toHaveLength(1);
  });

  it('does nothing when the look on screen is requested again', async () => {
    const { switcher, loads, ready } = harness();
    const first = switcher.request('wallis-dress');
    loads[0].deferred.resolve({ id: 'wallis-dress' });
    await first;

    await switcher.request('wallis-dress');
    expect(loads).toHaveLength(1);
    expect(ready).toHaveLength(1);
    expect(switcher.current).toBe('wallis-dress');
  });

  it('cancels the request in flight when the look on screen is requested again', async () => {
    const { switcher, loads, ready, disposed } = harness();
    const first = switcher.request('wallis-dress');
    loads[0].deferred.resolve({ id: 'wallis-dress' });
    await first;

    const second = switcher.request('zoot-suit');
    await switcher.request('wallis-dress');
    expect(loads[1].signal.aborted).toBe(true);
    expect(switcher.pending).toBeNull();
    expect(switcher.current).toBe('wallis-dress');

    const late: FakeLook = { id: 'zoot-suit' };
    loads[1].deferred.resolve(late);
    await second;
    expect(disposed).toEqual([late]);
    expect(ready).toHaveLength(1);
  });

  it('shares one load when the same look is requested twice in a row', async () => {
    const { switcher, loads, ready } = harness();
    const first = switcher.request('zoot-suit');
    const second = switcher.request('zoot-suit');
    expect(loads).toHaveLength(1);

    loads[0].deferred.resolve({ id: 'zoot-suit' });
    await Promise.all([first, second]);
    expect(ready).toHaveLength(1);
  });

  it('reports a failed load to its caller and leaves the look on screen alone', async () => {
    const { switcher, loads, disposed } = harness();
    const first = switcher.request('wallis-dress');
    loads[0].deferred.resolve({ id: 'wallis-dress' });
    await first;

    const second = switcher.request('zoot-suit');
    loads[1].deferred.reject(new Error('content: 404'));
    await expect(second).rejects.toThrow('404');
    expect(switcher.current).toBe('wallis-dress');
    expect(switcher.pending).toBeNull();
    expect(disposed).toEqual([]);
  });

  it('starts a fresh request after a failed one', async () => {
    const { switcher, loads, ready } = harness();
    const failed = switcher.request('zoot-suit');
    loads[0].deferred.reject(new Error('content: 404'));
    await expect(failed).rejects.toThrow('404');

    const retry = switcher.request('zoot-suit');
    expect(loads).toHaveLength(2);
    loads[1].deferred.resolve({ id: 'zoot-suit' });
    await retry;
    expect(ready).toHaveLength(1);
    expect(switcher.current).toBe('zoot-suit');
  });
});
