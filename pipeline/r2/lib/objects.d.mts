export interface ExclusionRule {
  exact?: string;
  prefix?: string;
  reason: string;
}

export interface DirEntryLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** Lists one directory's entries; injectable so tests can reorder the walk. */
export type ListDir = (dir: string) => DirEntryLike[];

export declare const CONTENT_TYPES: Record<string, string>;
export declare const FIXED_KEY_BY_PATH: Record<string, string>;
export declare const EXCLUDED_FILES: ExclusionRule[];

export declare function objectKeyFor(path: string, sha256: string): string;
export declare function contentTypeFor(path: string): string;
export declare function sha256Hex(bytes: Uint8Array): string;
export declare function exclusionReasonFor(path: string, exclusions?: ExclusionRule[]): string | null;
export declare function walkContentFiles(root: string, readdir?: ListDir): string[];
