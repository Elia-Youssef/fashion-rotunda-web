// Memoized dynamic imports for on-demand chunks (the screenshot module, the proof runtime, the
// environment fallbacks). A plain `??=` on the promise slot caches the rejection with the
// success, so one failed chunk load, a dropped request or an offline moment, fails every later
// call for the rest of the page's life. The loader below keeps the success and forgets the
// failure: the next call starts a new import, concurrent callers share one in-flight load, and
// each caller still sees its own attempt's rejection, so the existing failure handling and
// visitor messages at the call site stay untouched.

/**
 * Memoizes `load` for the page's life, except that a failed load is forgotten: the next call
 * runs `load` again instead of returning the cached rejection.
 */
export function lazyImport<T>(load: () => Promise<T>): () => Promise<T> {
  let ready: Promise<T> | null = null;
  return () => {
    // The catch derivative shares the slot: it clears it when the load fails and rethrows, so
    // callers receive the rejection itself while a later call starts a fresh import.
    ready ??= load().catch((error: unknown) => {
      ready = null;
      throw error;
    });
    return ready;
  };
}
