import type { Document } from '@gltf-transform/core';
import type { Vector3 } from 'three';
import type { DocumentSurfacePart } from './garment-coverage.mjs';
import type { NormalMeasurement } from './garment-measurement.mjs';
export interface NormalFitPolicy {
  garmentGroup: string; bodyGroup: string; clearance: number; extraFraction: number; maxPasses: number;
  minimumClearance?: number;
}
export interface NormalFitResult {
  history: { pass: number; outsideProbes: number; clearanceProbes: number; maxDepthMm: number }[];
  movedVertices: number; maxDisplacementMm: number; maxExtraMm: number; extraFraction: number;
}
export declare function measureNormalFaces(garment: DocumentSurfacePart[], body: DocumentSurfacePart[]): {
  measurement: NormalMeasurement; owners: Map<string, Set<string>>; normals: Map<string, Vector3>;
};
export declare function fitNormalInward(document: Document, policy: NormalFitPolicy): NormalFitResult;
