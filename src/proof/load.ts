import { lazyImport } from '../ui/lazy-import';
import { overlayWanted } from './overlay';

const loadRuntime = lazyImport(() => import('./runtime'));

/** Only proof-enabled pages prepare the panel, measurement orbit and GPU series. */
export function loadProof(search: string, isDev: boolean): Promise<typeof import('./runtime')> | null {
  if (!overlayWanted(search, isDev)) return null;
  return loadRuntime();
}
