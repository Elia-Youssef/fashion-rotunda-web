import type { ExclusionRule, ListDir } from './objects.d.mts';

export interface R2FileEntry {
  path: string;
  sha256: string;
  bytes: number;
  contentType: string;
  key: string;
  url: string;
}

export interface R2ExcludedEntry {
  path: string;
  reason: string;
}

export interface R2Totals {
  files: number;
  bytes: number;
  objects: number;
}

export interface R2Manifest {
  origin: string;
  files: R2FileEntry[];
  excluded: R2ExcludedEntry[];
  totals: R2Totals;
}

export declare const DEFAULT_ORIGIN: string;
export declare function normalizeOrigin(origin: string): string;
export declare function buildR2Manifest(input: {
  root: string;
  origin: string;
  readdir?: ListDir;
  exclusions?: ExclusionRule[];
}): R2Manifest;
export declare function manifestText(manifest: R2Manifest): string;
