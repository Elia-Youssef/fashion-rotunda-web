export interface DescriptionCorrection {
  lookId: string;
  source: string;
  replacement: string;
}

export declare const DESCRIPTION_CORRECTIONS: DescriptionCorrection[];
export declare function correctDescription(lookId: string, description: string): string;
