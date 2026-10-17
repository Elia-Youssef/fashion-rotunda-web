import type { DocumentSurfacePart, SurfacePart } from './garment-coverage.mjs';
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
