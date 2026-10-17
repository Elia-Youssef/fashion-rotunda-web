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
  it('retires a request started synchronously by an abort listener', async () => {
    const { switcher, loads, ready, disposed } = harness();
    const first = switcher.request('first');
    let reentrant: Promise<void> | undefined;
    loads[0].signal.addEventListener('abort', () => {
      reentrant = switcher.request('during-abort');
    }, { once: true });
    const last = switcher.request('last');
    expect(loads.map((entry) => entry.id)).toEqual(['first', 'during-abort', 'last']);
    loads[2].deferred.resolve({ id: 'last' });
    await last;
    loads[1].deferred.resolve({ id: 'during-abort' });
    loads[0].deferred.resolve({ id: 'first' });
    await Promise.all([first, reentrant]);
    expect(ready).toEqual([{ id: 'last', loaded: { id: 'last' } }]);
    expect(disposed).toEqual([{ id: 'during-abort' }, { id: 'first' }]);
    expect(switcher.current).toBe('last');
    expect(switcher.pending).toBeNull();
  });

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

  it('waits for the shared load before resolving a repeated request', async () => {
    const { switcher, loads, ready } = harness();
    const first = switcher.request('zoot-suit');
    let repeatedSettled = false;
    const second = switcher.request('zoot-suit').then(() => {
      repeatedSettled = true;
    });
    // Two microtask turns are enough for a wrongly immediate resolve to surface; the deduped
    // promise must stay pending until the shared load settles.
    await Promise.resolve();
    await Promise.resolve();
    expect(repeatedSettled).toBe(false);

    loads[0].deferred.resolve({ id: 'zoot-suit' });
    await Promise.all([first, second]);
    expect(repeatedSettled).toBe(true);
    expect(ready).toHaveLength(1);
  });

  it('does not abort the signal of a request that won', async () => {
    const { switcher, loads } = harness();
    const first = switcher.request('wallis-dress');
    loads[0].deferred.resolve({ id: 'wallis-dress' });
    await first;

    // A won request was never superseded, so the next switch must leave its signal alone.
    const second = switcher.request('zoot-suit');
    expect(loads[0].signal.aborted).toBe(false);
    loads[1].deferred.resolve({ id: 'zoot-suit' });
    await second;
  });

  it('does not abort the signal of a request that already failed', async () => {
    const { switcher, loads } = harness();
    const failed = switcher.request('wallis-dress');
    loads[0].deferred.reject(new Error('content: 404'));
    await expect(failed).rejects.toThrow('404');

    // The failed request is over, not superseded; the retry must not abort its signal.
    const retry = switcher.request('zoot-suit');
    expect(loads[0].signal.aborted).toBe(false);
    loads[1].deferred.resolve({ id: 'zoot-suit' });
    await retry;
  });

  it('does not answer a repeated request from inside load with a retired promise', async () => {
    const loads: Harness['loads'] = [];
    const ready: Harness['ready'] = [];
    const disposed: FakeLook[] = [];
    let fromInsideLoad: Promise<void> | null = null;
    const switcher = createSwitcher<FakeLook>({
      load: (id, signal) => {
        const entry = { id, signal, deferred: deferred<FakeLook>() };
        loads.push(entry);
        if (loads.length === 2) {
          // The second load asks again for its own look while it runs. Only the promise of the
          // run in flight may answer a repeated request; a promise left over from the request
          // this load replaced would settle from the wrong run.
          fromInsideLoad = switcher.request(id);
        }
        return entry.deferred.promise;
      },
      dispose: (loaded) => {
        disposed.push(loaded);
      },
      onReady: (id, loaded) => {
        ready.push({ id, loaded });
      },
    });

    const first = switcher.request('wallis-dress');
    const second = switcher.request('zoot-suit');
    const repeated = fromInsideLoad;
    if (repeated === null) {
      throw new Error('the load did not repeat its request');
    }
    // The repeated request superseded the load it was made from and started one of its own.
    expect(loads.map((entry) => entry.id)).toEqual(['wallis-dress', 'zoot-suit', 'zoot-suit']);
    expect(loads[1].signal.aborted).toBe(true);

    const zoot: FakeLook = { id: 'zoot-suit' };
    loads[2].deferred.resolve(zoot);
    await repeated;
    const wallis: FakeLook = { id: 'wallis-dress' };
    loads[0].deferred.resolve(wallis);
    loads[1].deferred.resolve({ id: 'zoot-suit' });
    await Promise.all([first, second]);

    expect(ready).toEqual([{ id: 'zoot-suit', loaded: zoot }]);
    expect(disposed).toEqual([wallis, { id: 'zoot-suit' }]);
    expect(switcher.current).toBe('zoot-suit');
    expect(switcher.pending).toBeNull();
  });

  it('hands a request started from onReady a switcher with nothing in flight', async () => {
    const loads: Harness['loads'] = [];
    const ready: Harness['ready'] = [];
    const disposed: FakeLook[] = [];
    let fromOnReady: Promise<void> | null = null;
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
        if (id === 'wallis-dress') {
          // The presenter may chain the next look the moment one lands. That request must find
          // the switcher already settled: the cleanup of the request that fired onReady would
          // otherwise overwrite its cancellation and its deduplication promise.
          fromOnReady = switcher.request('zoot-suit');
        }
      },
    });

    const first = switcher.request('wallis-dress');
    const wallis: FakeLook = { id: 'wallis-dress' };
    loads[0].deferred.resolve(wallis);
    await first;
    const chained = fromOnReady;
    if (chained === null) {
      throw new Error('onReady did not start its request');
    }
    expect(switcher.current).toBe('wallis-dress');
    expect(switcher.pending).toBe('zoot-suit');

    // Asking for the look on screen again must retire the chained request like any other.
    await switcher.request('wallis-dress');
    expect(loads[1].signal.aborted).toBe(true);
    const late: FakeLook = { id: 'zoot-suit' };
    loads[1].deferred.resolve(late);
    await chained;
    expect(ready).toEqual([{ id: 'wallis-dress', loaded: wallis }]);
    expect(disposed).toEqual([late]);
    expect(switcher.current).toBe('wallis-dress');
    expect(switcher.pending).toBeNull();
  });

  it('answers a repeat asked after a load restarted itself with the run in flight', async () => {
    const loads: Harness['loads'] = [];
    const ready: Harness['ready'] = [];
    const disposed: FakeLook[] = [];
    let fromInsideLoad: Promise<void> | null = null;
    const switcher = createSwitcher<FakeLook>({
      load: (id, signal) => {
        const entry = { id, signal, deferred: deferred<FakeLook>() };
        loads.push(entry);
        if (loads.length === 2) {
          fromInsideLoad = switcher.request(id);
        }
        return entry.deferred.promise;
      },
      dispose: (loaded) => {
        disposed.push(loaded);
      },
      onReady: (id, loaded) => {
        ready.push({ id, loaded });
      },
    });

    const first = switcher.request('wallis-dress');
    const second = switcher.request('zoot-suit');
    const restarted = fromInsideLoad;
    if (restarted === null) {
      throw new Error('the load did not repeat its request');
    }
    // The second load re-requested its own id and superseded itself; the run now in flight is
    // the third one. A repeat from outside must wait for that run, not for the retired second,
    // or it would resolve before any look arrived.
    let repeatSettled = false;
    const repeat = switcher.request('zoot-suit').then(() => {
      repeatSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(repeatSettled).toBe(false);

    loads[1].deferred.resolve({ id: 'zoot-suit' });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(repeatSettled).toBe(false);

    const winner: FakeLook = { id: 'zoot-suit' };
    loads[2].deferred.resolve(winner);
    loads[0].deferred.resolve({ id: 'wallis-dress' });
    await Promise.all([repeat, restarted, first, second]);
    expect(repeatSettled).toBe(true);
    expect(ready).toEqual([{ id: 'zoot-suit', loaded: winner }]);
    expect(switcher.current).toBe('zoot-suit');
  });
});
