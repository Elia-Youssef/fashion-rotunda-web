// One place for every machine-specific path the asset pipeline needs. Every script under pipeline/
// imports from here and nothing else hard-codes a path. The values are this machine's; docs/decisions.md
// records where each one came from.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** The repository root, one level above pipeline/. */
export const root = resolve(here, '..');

/** Blender 5.2 LTS stays off PATH on purpose: 4.3 and 3.6 are installed too. */
export const blenderExe = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';

/** KTX-Software 4.4.2. toktx from @gltf-transform/cli shells out to `ktx`, so this is prepended to PATH. */
export const ktxBin = 'C:\\Program Files\\KTX-Software\\bin';

/** Unreal Engine 5.8, the version the FashionRotunda project is associated with. */
export const unrealEditorCmd = 'C:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe';

/** The user's Unreal project, read only: the export scripts run inside it and write outside it. */
export const unrealProject = 'C:\\Users\\User\\Documents\\Unreal Projects\\FashionRotunda\\FashionRotunda.uproject';

/**
 * ffmpeg 8.1.1, the gyan.dev full build installed through winget, with libopus and the native aac
 * encoder. Not the ffmpeg on PATH: that is an older build without libopus. ffprobe sits beside it.
 */
const ffmpegBin =
  'C:\\Users\\User\\AppData\\Local\\Microsoft\\WinGet\\Packages\\' +
  'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin';
export const ffmpegExe = ffmpegBin + '\\ffmpeg.exe';
export const ffprobeExe = ffmpegBin + '\\ffprobe.exe';

/** Scripted exports out of Unreal land here; reproducible, so never modified by hand. */
export const sourceDir = resolve(root, 'assets-src', 'source');

/** Intermediate files: audits, cleaned meshes, pre-optimization GLBs. */
export const workDir = resolve(root, 'assets-src', 'work');

/** What the page loads. Not public/assets/, which Vite hashes and caches for a year. */
export const contentDir = resolve(root, 'public', 'content');

/** The environment the pipeline scripts run with: KTX on PATH, everything else inherited. */
export function pipelineEnv() {
  return { ...process.env, PATH: `${ktxBin};${process.env.PATH ?? ''}` };
}
