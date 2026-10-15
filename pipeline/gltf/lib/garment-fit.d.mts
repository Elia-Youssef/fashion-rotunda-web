import type { Document } from '@gltf-transform/core';
import type { BufferGeometry } from 'three';
import type { NormalMeasurement } from './garment-measurement.mjs';
import type { ContactFit } from './garment-shape.mjs';
import type { Coverage, CoverageOptions, SurfaceMeasurement, SurfacePart } from './garment-coverage.mjs';

export type SurfaceFitMethod = 'body-inward' | 'garment-outward';
export type FitMethod = SurfaceFitMethod | 'contact-clearance';

export interface FitResult {
  reference: Coverage;
  referenceBody: BufferGeometry;
  history: { pass: number; outsideSamples: number; maxDepthMm: number }[];
  movedVertices: number;
  maxDisplacementMm: number;
}

export type LookFit = { applied: false } | (FitResult & { applied: true; method: SurfaceFitMethod }) |
  (ContactFit & { applied: true; method: 'contact-clearance' });
export declare const MAX_FIT_PASSES: number;
export declare const LOOK_FIT_POLICIES: Record<string, {
  garmentGroup: string; bodyGroup: string; method: FitMethod; coverage?: CoverageOptions; margin?: number;
}>;
export declare function fitCoveredSurface(
  garmentParts: SurfacePart[], bodyParts: SurfacePart[], method?: SurfaceFitMethod, coverageOptions?: CoverageOptions,
  margin?: number,
): FitResult;
export declare function applyLookFit(document: Document, lookId: string, method?: FitMethod | null): LookFit;
export declare function validateFitOutput(
  document: Document, fit: LookFit,
): { checked: false } | ((SurfaceMeasurement | NormalMeasurement) & { checked: true });
