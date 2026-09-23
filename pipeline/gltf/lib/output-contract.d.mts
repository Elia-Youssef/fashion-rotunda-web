import type { Document } from '@gltf-transform/core';

export type ContractSlot = 'baseColor' | 'normal' | 'metallicRoughness' | 'occlusion';

export interface MaterialOutputContract {
  material: string;
  textures: Record<ContractSlot, string>;
}

export declare const OUTPUT_CONTRACTS: Record<string, MaterialOutputContract[]>;
export declare const SPECULAR_OUTPUT_CONTRACTS: Record<string, Record<string, number>>;

export declare function validateOutputContract(
  document: Document,
  options: { set: 'full' | 'half'; file: string },
): { checked: boolean; assertions: number };
