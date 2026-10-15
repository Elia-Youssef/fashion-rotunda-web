import type { WalkLoader, WalkLoadState, WalkSession, WalkSessionOptions } from './contracts';
import { createWalkSession } from './walk-session';

interface WalkModule {
  createWalkSession(options: WalkSessionOptions): WalkSession;
}

export interface WalkLoadOptions extends WalkSessionOptions {
  collisionUrl: string;
  importer?: () => Promise<WalkModule>;
  fetchCollision?: typeof fetch;
}

/** Owns attempts independently of the camera's requested mode. */
export function createWalkLoad(options: WalkLoadOptions): WalkLoader {
  const importer = options.importer ?? (() => Promise.resolve({ createWalkSession }));
  const fetchCollision = options.fetchCollision ?? fetch;
  let state: WalkLoadState = 'idle';
  let session: WalkSession | null = null;
  const listeners = new Set<() => void>();
  interface Attempt {
    abort: AbortController;
    partial: WalkSession | null;
    promise: Promise<WalkSession | null>;
    resolve(value: WalkSession | null): void;
    reject(error: unknown): void;
  }
  let attempt: Attempt | null = null;

  function publish(next: WalkLoadState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  function cancel(): void {
    const previous = attempt;
    attempt = null;
    previous?.abort.abort();
    previous?.partial?.dispose();
    previous?.resolve(null);
    if (state === 'loading') publish('idle');
  }

  return {
    get state() { return state; },
    get session() { return session; },
    ensureReady(): Promise<WalkSession | null> {
      if (state === 'disposed') return Promise.resolve(null);
      if (session !== null) return Promise.resolve(session);
      if (attempt !== null) return attempt.promise;
      let resolve!: Attempt['resolve'];
      let reject!: Attempt['reject'];
      const promise = new Promise<WalkSession | null>((yes, no) => { resolve = yes; reject = no; });
      const current: Attempt = { abort: new AbortController(), partial: null, promise, resolve, reject };
      attempt = current;
      publish('loading');
      // Observe both sides even if either fails. Fetch cancellation never touches scene loaders.
      const module = Promise.resolve().then(importer);
      const bytes = Promise.resolve().then(async () => {
        const response = await fetchCollision(options.collisionUrl, { signal: current.abort.signal });
        if (!response.ok) throw new Error(`collision mesh answered ${response.status}`);
        return response.arrayBuffer();
      });
      void Promise.all([module, bytes]).then(async ([runtime, data]) => {
        if (attempt !== current) return;
        current.partial = runtime.createWalkSession(options);
        await current.partial.loadCollision(data, current.abort.signal);
        if (attempt !== current) {
          current.partial.dispose();
          return;
        }
        session = current.partial;
        attempt = null;
        publish('ready');
        resolve(session);
      }).catch((error: unknown) => {
        current.abort.abort();
        current.partial?.dispose();
        if (attempt !== current) return;
        attempt = null;
        publish('error');
        reject(error);
      });
      return promise;
    },
    cancel,
    onStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose(): void {
      if (state === 'disposed') return;
      // End the lifetime before abort callbacks or late factories can publish resources.
      const previous = attempt;
      attempt = null;
      state = 'disposed';
      previous?.abort.abort();
      previous?.partial?.dispose();
      previous?.resolve(null);
      session?.dispose();
      session = null;
      listeners.clear();
    },
  };
}
