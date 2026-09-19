export declare const SRGB_SLOT_PATTERN: RegExp;
export declare const NORMAL_SLOT_PATTERN: RegExp;
export declare const COLOR_SLOTS: string[];
export declare function isColorSlot(slot: string): boolean;
export declare function isNormalSlot(slot: string): boolean;
export declare function colorSpaceOfSlots(slots: string[]): 'srgb' | 'linear';
export declare function encodingOfSlots(slots: string[]): 'uastc' | 'etc1s';
export declare function ktx2Format(encoding: 'uastc' | 'etc1s'): string;
export declare function isMannequinMaterial(materialName: string | null | undefined): boolean;
