import type { Document, Texture } from '@gltf-transform/core';

export type SourceTextureLoader = (name: string) => Uint8Array;

export interface CanonicalizedTextures {
  byName: Map<string, Texture>;
  canonicalized: string[];
}

export interface SourceTextureResult {
  texture: Texture;
  created: boolean;
}

export declare function canonicalizeSourceTextures(
  document: Document,
  sourceNames: Iterable<string> | Set<string> | null | undefined,
  loadSource: SourceTextureLoader,
): CanonicalizedTextures;

export declare function getOrCreateSourceTexture(
  document: Document,
  byName: Map<string, Texture>,
  name: string,
  loadSource: SourceTextureLoader,
): SourceTextureResult;
