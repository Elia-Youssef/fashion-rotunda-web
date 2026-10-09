// Camera presets and catalogue view integration.
// Stable ordering with proof first, followed by entrance, detail, inlay, and dome.
// Glides the orbit to the chosen preset pose, cutting instantly under reduced motion.

import type { CatalogView } from '../catalog/catalog';
import { prefersReducedMotion } from '../ui/announce';
import type { OrbitHandle } from './orbit';

export interface NamedView {
  id: string;
  label: string;
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

export interface PresetsHandle {
  readonly list: readonly NamedView[];
  /** Glides the orbit to the view over `ms` (0 under reduced motion); resolves when it lands. */
  goTo(id: string, ms?: number): Promise<void>;
}

const VIEW_LABELS: Record<string, string> = {
  proof: 'Proof',
  entrance: 'Entrance',
  detail: 'Detail',
  inlay: 'Inlay',
  dome: 'Dome',
};

function formatLabel(id: string): string {
  if (Object.prototype.hasOwnProperty.call(VIEW_LABELS, id)) {
    return VIEW_LABELS[id];
  }
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/**
 * Stable order: proof first, then the others by the order the catalogue lists them.
 */
export function listPresets(views: Record<string, CatalogView>): NamedView[] {
  const result: NamedView[] = [];
  const entries = Object.entries(views);

  const proofEntry = entries.find(([id]) => id === 'proof');
  if (proofEntry) {
    const [id, view] = proofEntry;
    result.push({
      id,
      label: formatLabel(id),
      position: [...view.position],
      target: [...view.target],
      fov: view.fov,
    });
  }

  for (const [id, view] of entries) {
    if (id === 'proof') {
      continue;
    }
    result.push({
      id,
      label: formatLabel(id),
      position: [...view.position],
      target: [...view.target],
      fov: view.fov,
    });
  }

  return result;
}

export function createPresets(
  views: Record<string, CatalogView>,
  orbit: OrbitHandle,
  reducedMotion?: () => boolean,
): PresetsHandle {
  const list = Object.freeze(listPresets(views));
  const isReduced = reducedMotion ?? prefersReducedMotion;

  return {
    get list(): readonly NamedView[] {
      return list;
    },

    async goTo(id: string, ms?: number): Promise<void> {
      const view = list.find((v) => v.id === id);
      if (!view) {
        throw new Error(`preset "${id}" not found`);
      }
      const duration = isReduced() ? 0 : (ms ?? 1200);
      await orbit.glideTo(view.position, view.target, duration, view.fov);
    },
  };
}
