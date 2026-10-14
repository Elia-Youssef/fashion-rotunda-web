import type { R2Manifest } from './manifest.d.mts';

export interface PlanCounts {
  files: number;
  objects: number;
  toUpload: number;
  skipped: number;
}

export interface PlanSkip {
  key: string;
  paths: string[];
}

export interface UploadPlan {
  commands: string[];
  skipped: PlanSkip[];
  counts: PlanCounts;
}

export interface PlanOptions {
  bucket: string;
  uploaded?: string[];
  fileBase?: string;
}

export declare const CACHE_CONTROL: string;
export declare const DEFAULT_BUCKET: string;
export declare const DEFAULT_FILE_BASE: string;
export declare function parseUploadedList(text: string): string[];
export declare function planUploads(manifest: R2Manifest, options: PlanOptions): UploadPlan;
export declare function renderPlanText(plan: UploadPlan): string;
