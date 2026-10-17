// Tracks environment construction resources until they are released or transferred to the result.

interface Disposable {
  dispose(): void;
}

/** A factory retains ownership until construction and the normal temporary releases succeed. */
function environmentResources() {
  const owned = new Set<Disposable>();
  return {
    own<T extends Disposable>(resource: T): T {
      owned.add(resource);
      return resource;
    },
    release(resource: Disposable): void {
      // Remove before calling: a throwing release is still one attempt, never a retry in finally.
      owned.delete(resource);
      resource.dispose();
    },
    transfer(...resources: Disposable[]): void {
      for (const resource of resources) owned.delete(resource);
    },
    cleanup(): void {
      const errors: unknown[] = [];
      for (const resource of owned) {
        owned.delete(resource);
        try {
          resource.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) console.warn('[archviz] environment resource release failed', errors);
    },
  };
}

type EnvironmentResources = ReturnType<typeof environmentResources>;

export { environmentResources };
export type { Disposable, EnvironmentResources };
