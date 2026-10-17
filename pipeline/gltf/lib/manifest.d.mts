import type { TextureFormat } from './budget.d.mts';

export interface ManifestTexture {
  name: string;
  width: number;
  height: number;
  format: TextureFormat;
  colorSpace: 'srgb' | 'linear';
  bytes: number;
  gpuBytes: number;
  floor: boolean;
}

export interface ManifestFile {
  bytes: number;
  triangles: number;
  meshes: number;
  nodes: number;
  materials: number;
  drawCalls: number;
  textures: ManifestTexture[];
  gpuBytes: number;
  largestTexture: number;
  largestNonFloorTexture: number;
}

export interface ManifestTotals {
  bytes: number;
  gpuBytes: number;
  triangles: number;
}

export interface ManifestError {
  set: string;
  file: string;
  texture: string;
  message: string;
}

export interface Manifest {
  sets: Record<string, { files: Record<string, ManifestFile>; totals: ManifestTotals }>;
  errors: ManifestError[];
}

export declare const SET_NAMES: string[];
export declare function textureEntry(input: {
  name: string;
  width: number;
  height: number;
  format: TextureFormat;
  colorSpace: 'srgb' | 'linear';
  bytes: number;
  floor?: boolean;
}): ManifestTexture;
export declare function fileEntry(input: {
  bytes: number;
  triangles: number;
  meshes: number;
  nodes: number;
  materials: number;
  drawCalls: number;
  textures: ManifestTexture[];
}): ManifestFile;
export declare function totalsOf(files: Record<string, ManifestFile>): ManifestTotals;
export declare function buildManifest(
  sets: Record<string, Record<string, ManifestFile>>,
  errors?: ManifestError[],
): Manifest;
export declare function shippedJson(value: unknown): string;
