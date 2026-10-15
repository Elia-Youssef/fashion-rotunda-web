import type { Vector3 } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import type { DocumentSurfacePart, SurfacePart } from './garment-coverage.mjs';
export declare const HEIGHT_BAND: number;
export declare function createVertexCoverage(garment: SurfacePart[], body: SurfacePart[]): {
  query(point: Vector3): { center: Vector3; direction: Vector3; reach: number } | null;
  garment: MeshBVH;
};
export interface NormalMeasurement {
  uniqueVertices: number;
  coveredVertices: number;
  unprobedVertices: number;
  outsideVertices: number;
  samples: { point: number[]; normal: number[]; depthMm: number; outside: boolean;
    inwardMm: number | null; outwardMm: number | null }[];
  bands: Record<string, { covered: number; outside: number; depthsMm: number[] }>;
}
export declare function measureNormalVertices(garment: SurfacePart[], body: DocumentSurfacePart[],
  referenceBody?: SurfacePart[]): NormalMeasurement;
