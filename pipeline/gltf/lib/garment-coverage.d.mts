import type { Document, Primitive } from '@gltf-transform/core';
import type { BufferGeometry, Line3, Matrix4, Vector3 } from 'three';

export interface SurfacePart {
  points: Vector3[];
  indices: number[];
}

export interface DocumentSurfacePart extends SurfacePart {
  primitive: Primitive;
  matrix: Matrix4;
}

export interface SurfaceTopology {
  points: Vector3[];
  triangles: number[][];
  boundary: Line3[];
  loops: { vertices: number[]; closed: boolean; min: number[]; max: number[] }[];
  degenerateFaces: number;
  nonManifoldEdges: number;
  inconsistentEdges: number;
}

export interface CoverageHit {
  center: Vector3;
  direction: Vector3;
  radius: number;
  shellRadius: number;
  depth: number;
  openingDistance: number;
  point: Vector3;
  faceIndex: number;
}

export interface Coverage {
  query(point: Vector3): CoverageHit | null;
  centerAt(y: number): Vector3 | null;
  shellRadiusAt(point: Vector3): number | null;
  topology: SurfaceTopology;
  options: CoverageOptions;
}

export interface CoverageOptions { includeIntersectingIntervals?: boolean; }

export interface SurfaceMeasurement {
  totalFaces: number;
  penetratingFaces: number;
  uniqueSamples: number;
  coveredSamples: number;
  outsideSamples: number;
  bands: Record<string, { covered: number; outside: number; depthsMm: number[] }>;
  penetrations: { point: number[]; depthMm: number; openingDistanceMm: number }[];
}

export declare const SEAM_TOLERANCE: number;
export declare const CONTACT_TOLERANCE: number;
export declare const FIT_MARGIN: number;
export declare const OPENING_GUARD: number;
export declare function surfaceParts(document: Document, groupName: string): DocumentSurfacePart[];
export declare function combinedSurface(parts: SurfacePart[]): BufferGeometry;
export declare function surfaceTopology(geometry: BufferGeometry): SurfaceTopology;
export declare function createCoverage(
  garmentGeometry: BufferGeometry, bodyGeometry: BufferGeometry, reference?: Coverage | null,
  options?: CoverageOptions,
): Coverage;
export declare function faceSamples(a: Vector3, b: Vector3, c: Vector3): Vector3[];
export declare function measureSurface(parts: SurfacePart[], coverage: Coverage): SurfaceMeasurement;
