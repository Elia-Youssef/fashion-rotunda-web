import type { Ray } from 'three';
import type { SurfacePart } from './garment-coverage.mjs';
export declare function surfaceRaycaster(parts: SurfacePart[], doubleSided?: boolean): (ray: Ray) => {
  distance: number; point: import('three').Vector3; faceIndex: number;
} | null;
export interface VisibilityComparison {
  width: number; height: number; referenceGarmentPixels: number; exposedBodyPixels: number;
  samples: { pixel: number[]; bodyPoint: number[]; referencePoint: number[];
    garmentPoint: number[] | null; gapMm: number | null; backfaceOnly: boolean;
    bodyFace: number; referenceFace: number }[];
}
export declare function compareGarmentViews(
  reference: { garment: SurfacePart[]; body: SurfacePart[] },
  candidate: { garment: SurfacePart[]; body: SurfacePart[] },
  view: { position: number[]; target: number[]; fov: number }, width: number, height: number,
): VisibilityComparison;
