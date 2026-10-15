import type { BufferGeometry, Vector3 } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
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
export declare const GARMENT_FALLOFF_RADIUS: number;
export declare const MIN_CONTACT_SUPPORT_EDGES: number;
export declare const MAX_SHELL_PASSES: number;
export declare const MAX_TORSO_PASSES: number;
export declare const EDGE_RATIO_HEADROOM: number;
export declare const MAX_FALLOFF_PASSES: number;
export declare const FALLOFF_TOLERANCE: number;
export declare function snapshotSurfaces(garment: SurfacePart[], body: SurfacePart[]): ShapeSnapshot;
export declare function validateSurfaceShape(garment: SurfacePart[], body: SurfacePart[], before: ShapeSnapshot): ShapeResult;
export declare function garmentFalloff(distance: number, radius: number): number;
export declare function closestBodyExit(surface: MeshBVH, point: Vector3, outward: Vector3): { direction: Vector3; depth: number };
export declare function constrainGarmentFalloff(offsets: Vector3[], neighbors: Map<number, number>[], points: Vector3[], pinned?: Set<number>): void;
export declare function fitCoveredTorso(garment: SurfacePart[], body: SurfacePart[]): { movedVertices: number };
export declare function fitSmoothGarment(garment: SurfacePart[], body: DocumentSurfacePart[], options?: CoverageOptions,
  adjustment?: BodyAdjustment | null): SmoothGarmentFit;
export declare function fitContactClearance(garment: DocumentSurfacePart[], body: DocumentSurfacePart[]): ContactFit;
