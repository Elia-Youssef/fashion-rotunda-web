/** Typed public contract for the JavaScript-only asset-pipeline configuration. */
export const root: string;
export const blenderExe: string;
export const ktxBin: string;
export const unrealEditorCmd: string;
export const unrealProject: string;
export const ffmpegExe: string;
export const ffprobeExe: string;
export const sourceDir: string;
export const workDir: string;
export const contentDir: string;

export function pipelineEnv(): NodeJS.ProcessEnv;
