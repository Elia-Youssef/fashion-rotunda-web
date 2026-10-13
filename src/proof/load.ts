import { overlayWanted } from './overlay';

let ready: Promise<typeof import('./runtime')> | null = null;

/** Only proof-enabled pages prepare the panel, measurement orbit and GPU series. */
export function loadProof(search: string, isDev: boolean): Promise<typeof import('./runtime')> | null {
  if (!overlayWanted(search, isDev)) return null;
  ready ??= import('./runtime');
  return ready;
}
