export type AssetSet = 'full' | 'half';

export interface CapFlags {
  floor?: boolean;
  mannequin?: boolean; staticNormal?: boolean;
}

export declare const FLOOR_MESH_NAME: string;
export declare const TEXTURE_CAPS: Record<AssetSet, { default: number; floor: number; mannequin: number }>;
export declare function textureCap(set: AssetSet, flags?: CapFlags): number;
export declare function targetSize(size: [number, number], cap: number): [number, number];
export declare function needsResize(size: [number, number], target: [number, number]): boolean;
