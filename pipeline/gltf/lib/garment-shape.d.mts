import type { BufferGeometry, Vector3 } from 'three';
import type { Coverage, CoverageOptions, DocumentSurfacePart, SurfacePart } from './garment-coverage.mjs';
import type { NormalMeasurement } from './garment-measurement.mjs';
export interface ShapeSnapshot { garment: SurfacePart[]; body: SurfacePart[]; protectedBody?: boolean[][]; }
export interface ShapeResult { maxDisplacementMm: number; maxEdgeRatio: number; protectedBodyVerticesMoved: number; }
export interface BodyAdjustment {
  reference: Coverage; referenceBody: BufferGeometry; protectedBody: boolean[][];
  update(garment: DocumentSurfacePart[], body: DocumentSurfacePart[], reference: Coverage): void;
}
export interface SmoothGarmentFit {
  reference: Coverage;
  referenceBody: BufferGeometry;
  history: { pass: number; outsideVertices: number; maxDepthMm: number }[];
  shape: ShapeResult;
  shapeReference: ShapeSnapshot;
  movedVertices: number;
  maxDisplacementMm: number;
  normalMeasurement: NormalMeasurement;
}
export interface ContactFit extends SmoothGarmentFit { fittedSurfaces: ShapeSnapshot; torsoMovedVertices: number; }
export declare const MAX_GARMENT_DISPLACEMENT: number;
export declare const MAX_GARMENT_EDGE_RATIO: number;
export declare function snapshotSurfaces(garment: SurfacePart[], body: SurfacePart[]): ShapeSnapshot;
export declare function validateSurfaceShape(garment: SurfacePart[], body: SurfacePart[], before: ShapeSnapshot): ShapeResult;
export declare function constrainGarmentFalloff(offsets: Vector3[], neighbors: Map<number, number>[], points: Vector3[], pinned?: Set<number>): void;
export declare function fitSmoothGarment(garment: SurfacePart[], body: DocumentSurfacePart[], options?: CoverageOptions,
  adjustment?: BodyAdjustment | null): SmoothGarmentFit;
export declare function fitContactClearance(garment: DocumentSurfacePart[], body: DocumentSurfacePart[]): ContactFit;
