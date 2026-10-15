import type { SurfacePart } from './garment-coverage.mjs';
export declare function findSurfaceIntersection(parts: SurfacePart[]): { first: number; second: number } | null;
export declare function assertNoSurfaceIntersections(parts: SurfacePart[]): void;
