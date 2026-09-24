// One place for every machine-specific path the asset pipeline needs. Every script under pipeline/
// imports from here and nothing else hard-codes a path. The project runs on two Windows machines, a
// desktop and a laptop: a tool that lives in a different place on each lists both locations and the
// first one that exists wins. An FR_* environment variable overrides the search on any machine.

import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** The first candidate that exists, else the first one, so an error still names an expected path. */
function firstExisting(candidates) {
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

/** The repository root, one level above pipeline/. */
export const root = resolve(here, '..');

/** Blender 5.2 LTS, the same path on both machines. Off PATH on purpose: older versions are installed too. */
export const blenderExe = 'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe';

/** KTX-Software 4.4.2. toktx from @gltf-transform/cli shells out to `ktx`, so this is prepended to PATH. */
export const ktxBin = process.env.FR_KTX_BIN ?? 'C:\\Program Files\\KTX-Software\\bin';

/** Unreal Engine 5.8's commandlet: under Program Files on the laptop, under F:\Epic Games on the desktop. */
export const unrealEditorCmd = resolve(
  process.env.FR_UNREAL_EDITOR_CMD ??
    firstExisting([
      'C:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe',
      'F:\\Epic Games\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe',
    ]),
);

/**
 * The authoritative Unreal project, read-only for every script: under Documents on the laptop, beside
 * the web project on the desktop. It is copied onto a machine only when Unreal work needs it, so it can
 * be absent. FR_UNREAL_PROJECT overrides the search without editing a tracked file.
 */
export const unrealProject = resolve(
  process.env.FR_UNREAL_PROJECT ??
    firstExisting([
      'C:\\Users\\User\\Documents\\Unreal Projects\\FashionRotunda\\FashionRotunda.uproject',
      'E:\\Fashion-Rotunda-WebGPU\\FashionRotunda\\FashionRotunda.uproject',
    ]),
);

/**
 * ffmpeg, the gyan.dev full build installed through winget, with libopus and the native aac encoder.
 * Not the ffmpeg on PATH: that is an older build without libopus. The version folder differs per
 * machine (8.1.1 on the laptop, 8.1 on the desktop), so the newest installed build is found rather
 * than pinned; FR_FFMPEG_BIN overrides the search. ffprobe sits beside it.
 */
const wingetFfmpeg =
  'C:\\Users\\User\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe';
function findFfmpegBin() {
  if (process.env.FR_FFMPEG_BIN) return process.env.FR_FFMPEG_BIN;
  const builds = existsSync(wingetFfmpeg)
    ? readdirSync(wingetFfmpeg)
        .filter((name) => /^ffmpeg-[\d.]+-full_build$/.test(name))
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    : [];
  return `${wingetFfmpeg}\\${builds.at(-1) ?? 'ffmpeg-8.1.1-full_build'}\\bin`;
}
const ffmpegBin = findFfmpegBin();
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
