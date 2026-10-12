export interface LookText {
  description: string;
  sourceUrl: string;
}

export declare const LOOK_TEXT: Record<string, LookText>;
export declare function validateLookText(
  looks: readonly { id: string }[],
  text?: Record<string, LookText>,
): void;
export declare function applyLookText<T extends { id: string }>(
  looks: readonly T[],
  text?: Record<string, LookText>,
): (T & LookText)[];
export declare function writeCatalogTexts(paths: readonly string[]): void;
