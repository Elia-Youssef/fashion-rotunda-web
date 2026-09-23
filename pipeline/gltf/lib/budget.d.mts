import type { AssetSet } from './sizing.d.mts';
import type { ManifestFile } from './manifest.d.mts';

export type TextureFormat = 'ktx2-uastc' | 'ktx2-etc1s' | 'png' | 'jpeg';

export interface BudgetRow {
  key: string;
  label: string;
  actual: number;
  target: number;
  unit: 'bytes' | 'count';
  pass: boolean;
}

export interface BudgetInfo {
  allFilesGpuBytes: number;
  allFilesBytes: number;
  heaviestLookByGpu: string | null;
  heaviestLookByTriangles: string | null;
  /** The ?sky=hdr diagnostic environment, reported apart from the first-frame payload row. */
  environmentFile: string | null;
  environmentBytes: number;
}

export declare const MIP_FACTOR: number;
export declare const BYTES_PER_PIXEL: Record<TextureFormat, number>;
export declare const BUDGETS: Record<AssetSet, Record<string, number>>;
export declare function gpuBytes(width: number, height: number, format: TextureFormat): number;
export declare function budgetRows(
  set: AssetSet,
  files: Record<string, ManifestFile>,
  firstLook: string,
  environment: string | null,
): { rows: BudgetRow[]; info: BudgetInfo };
export declare function formatBudgetTable(set: AssetSet, rows: BudgetRow[], info?: BudgetInfo): string;
export declare function formatMb(bytes: number): string;
