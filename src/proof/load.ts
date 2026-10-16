import { lazyImport } from '../ui/lazy-import';
import { overlayWanted } from './overlay';

const loadRuntime = lazyImport(() => import('./runtime'));

/** Missing optional proof tools disable the panel and its timing work without blocking startup. */
export async function loadProof(search: string, isDev: boolean): Promise<typeof import('./runtime') | null> {
  if (!overlayWanted(search, isDev)) return null;
  try {
    return await loadRuntime();
  } catch (error) {
    console.warn('[archviz] proof overlay unavailable:', error instanceof Error ? error.message : String(error));
    return null;
  }
}
