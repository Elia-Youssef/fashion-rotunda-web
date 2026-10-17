import type { Document } from '@gltf-transform/core';
import type { DocumentSurfacePart, SurfacePart } from './garment-coverage.mjs';
import type { NormalFitPolicy, NormalFitResult } from './garment-normal-fit.mjs';
export declare const HALF_LOOK_FIT_POLICIES: Record<string, NormalFitPolicy & { bodyTriangles: number }>;
export declare function surfaceTriangles(parts: SurfacePart[]): number;
export declare function simplifySurfaceBudget(parts: DocumentSurfacePart[], target: number,
  simplifier: unknown, error: number, lockBorder?: boolean): void;
export declare function applyHalfLookFit(document: Document, lookId: string, set: string,
  totalBudget: number, simplifier: unknown, error: number): { applied: false } |
  (NormalFitResult & { applied: true; bodyTriangles: number; garmentTriangles: number });
