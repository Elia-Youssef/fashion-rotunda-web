import type { Document } from '@gltf-transform/core';
import type { BufferGeometry } from 'three';
import type { Coverage, SurfaceMeasurement, SurfacePart } from './garment-coverage.mjs';

export type FitMethod = 'body-inward' | 'garment-outward';

export interface FitResult {
  reference: Coverage;
  referenceBody: BufferGeometry;
  history: { pass: number; outsideSamples: number; maxDepthMm: number }[];
  movedVertices: number;
  maxDisplacementMm: number;
}

export type LookFit = { applied: false } | (FitResult & { applied: true; method: FitMethod });
export declare const MAX_FIT_PASSES: number;
export declare const LOOK_FIT_POLICIES: Record<string, {
  garmentGroup: string; bodyGroup: string; method: FitMethod;
}>;
export declare function fitCoveredSurface(
  garmentParts: SurfacePart[], bodyParts: SurfacePart[], method?: FitMethod,
): FitResult;
export declare function applyLookFit(document: Document, lookId: string, method?: FitMethod | null): LookFit;
export declare function validateFitOutput(
  document: Document, fit: LookFit,
): { checked: false } | (SurfaceMeasurement & { checked: true });
