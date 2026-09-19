export type RepairSlot = 'baseColor' | 'normal' | 'metallicRoughness' | 'occlusion';

export interface MaterialSlots {
  name: string;
  baseColor?: string | null;
  normal?: string | null;
  metallicRoughness?: string | null;
  occlusion?: string | null;
}

export interface Repair {
  slot: RepairSlot;
  from: string | null;
  to: string;
  reason: 'empty-slot' | 'orm-in-normal-slot';
}

export declare const REPAIRABLE_SLOTS: RepairSlot[];
export declare const SLOT_SUFFIX: Record<RepairSlot, string>;
export declare function materialKey(materialName: string | null | undefined): string | null;
export declare function sourceTextureName(key: string, suffix: string): string;
export declare function isOrmName(textureName: string | null | undefined): boolean;
export declare function planRepairs(
  material: MaterialSlots,
  available: Iterable<string> | Set<string> | null | undefined,
): Repair[];

export interface MaterialFactors {
  baseColor?: number[] | null;
  metallic: number;
  roughness: number;
}

export interface FactorReset {
  factor: 'baseColor' | 'metallic' | 'roughness';
  from: number | number[];
  to: number | number[];
}

export declare const NEUTRAL_BASE_COLOR: number[];
export declare function planFactorResets(repairs: Repair[], factors: MaterialFactors): FactorReset[];
