import type { Document, Texture } from '@gltf-transform/core';
import type { AssetSet } from './sizing.mjs';

export interface TexturePlanContext {
  file: string;
  look?: unknown;
}

export interface TexturePlanEntry {
  texture: Texture;
  name: string;
  pattern: RegExp;
  floor: boolean;
  mannequin: boolean;
  role: 'floor' | 'mannequin' | 'other';
  slots: string[];
  size: [number, number] | null;
  cap: number | null;
  target: [number, number] | null;
  encoding: 'uastc' | 'etc1s';
  colorSpace: 'srgb' | 'linear';
}

export declare function planTextures(
  document: Document,
  set: AssetSet,
  item: TexturePlanContext,
): TexturePlanEntry[];
