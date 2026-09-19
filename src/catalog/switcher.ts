// Goal G1.7: one in-flight look request, and only one. A visitor clicking two thumbnails in a
// second must end on the second one, whichever fetch happens to finish first, and the loser's
// GPU resources must be freed rather than left on the heap.
//
// The rule is a generation counter, never a timestamp: two requests started in the same
// millisecond are indistinguishable by clock, and a slow first request that resolves after a fast
// second one is exactly the case this module exists for. Nothing here touches three.js or the DOM,
// so the whole race is testable with deferred promises.

export interface SwitcherOptions<T> {
  /** Fetches and builds one look. The signal is aborted when a later request supersedes this one. */
  load: (id: string, signal: AbortSignal) => Promise<T>;
  /** Frees a look that is being replaced or that arrived after it had already lost. */
  dispose: (loaded: T) => void;
  /** Exactly once per request that wins, with the look that is now on screen. */
  onReady: (id: string, loaded: T) => void;
}

export interface Switcher {
  /** Resolves when this request either won or was superseded. Rejects only when its own load did. */
  request(id: string): Promise<void>;
  /** The id whose look is on screen. */
  readonly current: string | null;
  /** The id in flight, if any. */
  readonly pending: string | null;
}

export function createSwitcher<T>(options: SwitcherOptions<T>): Switcher {
  let current: string | null = null;
  let pending: string | null = null;
  let pendingPromise: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let generation = 0;

  /** Retires whatever is in flight. The run itself notices through the generation counter. */
  function abortPending(): void {
    if (controller !== null) {
      // The counter moves here and not only when a new request starts. Aborting a fetch does not
      // stop a load that is already past its network step, and without this the retired run would
      // still match the current generation and put its look on screen.
      generation += 1;
      controller.abort();
      controller = null;
    }
    pending = null;
    pendingPromise = null;
  }

  async function run(id: string, mine: number, signal: AbortSignal): Promise<void> {
    let loaded: T;
    try {
      loaded = await options.load(id, signal);
    } catch (error) {
      if (mine !== generation) {
        // A superseded request failing is the expected outcome of aborting it, not an error the
        // caller should see: its promise resolves, like any other superseded request.
        return;
      }
      pending = null;
      pendingPromise = null;
      controller = null;
      throw error;
    }
    if (mine !== generation) {
      options.dispose(loaded);
      return;
    }
    pending = null;
    pendingPromise = null;
    controller = null;
    current = id;
    options.onReady(id, loaded);
  }

  return {
    request(id: string): Promise<void> {
      if (id === current) {
        // Already on screen. Anything in flight is now unwanted, including a request for a third
        // look that the visitor has just changed their mind about.
        abortPending();
        return Promise.resolve();
      }
      if (id === pending && pendingPromise !== null) {
        // The same look is already coming. Hand back the running promise so this caller waits for
        // the same outcome instead of resolving early.
        return pendingPromise;
      }
      abortPending();
      generation += 1;
      const mine = generation;
      const mineController = new AbortController();
      controller = mineController;
      pending = id;
      const promise = run(id, mine, mineController.signal);
      // A load that fails before its first await settles `run` synchronously, and it has already
      // cleared the pending state by the time control returns here; the guard keeps this from
      // resurrecting it.
      if (pending === id && generation === mine) {
        pendingPromise = promise;
      }
      return promise;
    },
    get current(): string | null {
      return current;
    },
    get pending(): string | null {
      return pending;
    },
  };
}
