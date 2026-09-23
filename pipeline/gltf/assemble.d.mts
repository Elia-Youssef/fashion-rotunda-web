export declare const assembledDir: string;
export declare function plainText(value: unknown): string;
export declare function resolveExportFile(exportRoot: string, recordedPath: unknown): string;
export declare function assemble(options?: {
  out?: string;
  log?: (message: string) => void;
}): Promise<{ out: string; catalog: unknown; source: unknown }>;
