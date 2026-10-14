import type { ManifestTotals } from './manifest.mjs';

interface MetricFile {
  bytes: number;
  triangles: number;
  gpuBytes: number;
}

interface ManifestInput {
  sets: Record<'full' | 'half', { files: Record<string, MetricFile>; totals: Partial<ManifestTotals> }>;
  errors: { file: string }[];
}

export declare function selectLook<T extends { file: string; look?: { id: string } }>(plan: T[], id: string): T[];
export declare function updateSelectedManifest<M extends ManifestInput, F extends MetricFile, E extends { file: string }>(
  before: M, file: string, entries: Record<'full' | 'half', F>, errors: E[],
): M;
export declare function updateSelectedCatalog<C extends { looks: { id: string }[] }>(
  before: C, candidate: { looks: { id: string }[] }, id: string,
): C;
