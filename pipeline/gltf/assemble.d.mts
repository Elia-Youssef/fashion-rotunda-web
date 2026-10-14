export declare const assembledDir: string;
export declare function isWithinExportRoot(
  exportRoot: string,
  candidate: string,
  paths?: Pick<typeof import('node:path'), 'relative' | 'isAbsolute'>,
): boolean;
export declare function plainText(value: unknown): string;
export declare function resolveExportFile(exportRoot: string, recordedPath: unknown): string;
export declare function assemble(options?: {
  out?: string;
  log?: (message: string) => void;
  only?: string | null;
  exportRoot?: string;
}): Promise<{ out: string; catalog: unknown; source: unknown }>;
