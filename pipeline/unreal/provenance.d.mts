export interface TreeEntry {
  path: string;
  type: 'file' | 'symlink' | 'other';
  bytes: number;
  sha256: string | null;
}

export interface TreeManifest {
  path: string;
  exists: boolean;
  files: number;
  bytes: number;
  digest: string | null;
  entries: TreeEntry[];
}

export const exportEvidenceRoot: string;
export const knownGoodTrees: readonly string[];

export function assertNewIsolatedOutput(candidate: string): string;
export function createEvidenceRun(now?: Date, entropy?: string): {
  runDirectory: string;
  outputDirectory: string;
};
export function hashTree(directory: string): TreeManifest;
export function hashKnownGoodTrees(): Record<string, TreeManifest>;
export function projectInventory(project: string): {
  path: string;
  exists: boolean;
  sha256: string | null;
  projectDirectory: string;
  immediateEntries: Array<{
    name: string;
    type: 'directory' | 'file' | 'other';
    bytes: number | null;
    modifiedAt: string;
  }>;
};
export function assertMatchingManifests(before: TreeManifest, after: TreeManifest, label: string): void;
