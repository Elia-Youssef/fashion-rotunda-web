import { existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ktxBin, pipelineEnv } from '../../pipeline/config.mjs';

// The module under test reads the real file system to find tools; the mock keeps every call
// honest by default and lets a test narrow which paths exist, so no test touches a real tool.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => actual.existsSync(path)),
    readdirSync: vi.fn((path: string): string[] => actual.readdirSync(path)),
  };
});

const mockExists = existsSync as unknown as Mock<(path: string) => boolean>;
const mockList = readdirSync as unknown as Mock<(path: string) => string[]>;

const envOverrides = [
  'FR_KTX_BIN',
  'FR_FFMPEG_BIN',
  'FR_UNREAL_EDITOR_CMD',
  'FR_UNREAL_PROJECT',
  'FR_PROVENANCE_DIR',
];

const editorCandidates = {
  programFiles: 'C:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe',
  desktop: 'F:\\Epic Games\\UE_5.8\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe',
};

const projectCandidates = {
  documents: 'C:\\Users\\User\\Documents\\Unreal Projects\\FashionRotunda\\FashionRotunda.uproject',
  desktop: 'E:\\Fashion-Rotunda-WebGPU\\FashionRotunda\\FashionRotunda.uproject',
};

const wingetRoot =
  'C:\\Users\\User\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe';

beforeEach(async () => {
  // Every fresh import starts from the real file system unless a test narrows it first.
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  mockExists.mockImplementation((path) => actual.existsSync(path));
  mockList.mockImplementation((path) => actual.readdirSync(path));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Imports the module fresh with every FR_ override removed; `arrange` narrows the file system. */
async function importWithoutOverrides(arrange?: () => void) {
  const saved = envOverrides
    .map((key) => [key, process.env[key]] as const)
    .filter((entry) => entry[1] !== undefined);
  for (const key of envOverrides) delete process.env[key];
  try {
    arrange?.();
    vi.resetModules();
    return await import('../../pipeline/config.mjs');
  } finally {
    vi.resetModules();
    for (const [key, value] of saved) process.env[key] = value;
  }
}

function letOnlyExist(...paths: string[]) {
  const present = new Set(paths);
  mockExists.mockImplementation((path) => present.has(path));
}

function wingetLists(names: string[]) {
  mockList.mockImplementation((path) => (path === wingetRoot ? names : []));
}

describe('pipeline tool environment', () => {
  it('puts the KTX binaries first on PATH and keeps every inherited variable', () => {
    const env = pipelineEnv();
    expect(env.PATH).toBe(`${ktxBin};${process.env.PATH ?? ''}`);
    for (const [key, value] of Object.entries(process.env)) {
      if (key === 'PATH') continue;
      expect(env[key]).toBe(value);
    }
  });

  it('appends the KTX folder to PATH even when the environment has none', () => {
    const saved = process.env.PATH;
    const hadPath = 'PATH' in process.env;
    delete process.env.PATH;
    try {
      expect(pipelineEnv().PATH).toBe(`${ktxBin};`);
    } finally {
      if (hadPath) process.env.PATH = saved;
    }
  });

  it('lets FR_KTX_BIN and FR_FFMPEG_BIN redirect the tool search', async () => {
    vi.stubEnv('FR_KTX_BIN', 'X:\\ktx');
    vi.stubEnv('FR_FFMPEG_BIN', 'X:\\ffmpeg\\bin');
    vi.resetModules();
    const config = await import('../../pipeline/config.mjs');
    expect(config.ktxBin).toBe('X:\\ktx');
    expect(config.ffmpegExe).toBe('X:\\ffmpeg\\bin\\ffmpeg.exe');
    expect(config.ffprobeExe).toBe('X:\\ffmpeg\\bin\\ffprobe.exe');
    expect(config.pipelineEnv().PATH?.startsWith('X:\\ktx;')).toBe(true);
  });

  it('lets the Unreal overrides redirect both searches', async () => {
    vi.stubEnv('FR_UNREAL_EDITOR_CMD', 'X:\\ue\\UnrealEditor-Cmd.exe');
    vi.stubEnv('FR_UNREAL_PROJECT', 'X:\\ue\\FashionRotunda.uproject');
    vi.resetModules();
    const config = await import('../../pipeline/config.mjs');
    expect(config.unrealEditorCmd).toBe('X:\\ue\\UnrealEditor-Cmd.exe');
    expect(config.unrealProject).toBe('X:\\ue\\FashionRotunda.uproject');
  });

  it('lets FR_PROVENANCE_DIR move the provenance output', async () => {
    vi.stubEnv('FR_PROVENANCE_DIR', 'X:\\provenance');
    vi.resetModules();
    const config = await import('../../pipeline/config.mjs');
    expect(config.provenanceDir).toBe('X:\\provenance');
  });

  it('resolves the module layout from the repository root by default', async () => {
    const config = await importWithoutOverrides();
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    expect(config.root).toBe(repoRoot);
    expect(config.blenderExe).toBe('C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe');
    expect(config.ktxBin).toBe('C:\\Program Files\\KTX-Software\\bin');
    expect(config.sourceDir).toBe(resolve(repoRoot, 'assets-src', 'source'));
    expect(config.workDir).toBe(resolve(repoRoot, 'assets-src', 'work'));
    expect(config.provenanceDir).toBe(resolve(repoRoot, 'assets-src', 'work', 'export-provenance'));
    expect(config.contentDir).toBe(resolve(repoRoot, 'public', 'content'));
  });

  it('prefers the first existing Unreal editor candidate and falls back to naming it', async () => {
    const both = await importWithoutOverrides(() =>
      letOnlyExist(editorCandidates.programFiles, editorCandidates.desktop),
    );
    expect(both.unrealEditorCmd).toBe(editorCandidates.programFiles);
    const none = await importWithoutOverrides(() => letOnlyExist());
    expect(none.unrealEditorCmd).toBe(editorCandidates.programFiles);
  });

  it('uses the second Unreal editor candidate when the first is absent', async () => {
    const config = await importWithoutOverrides(() => letOnlyExist(editorCandidates.desktop));
    expect(config.unrealEditorCmd).toBe(editorCandidates.desktop);
  });

  it('prefers the first existing Unreal project candidate and falls back to naming it', async () => {
    const both = await importWithoutOverrides(() =>
      letOnlyExist(projectCandidates.documents, projectCandidates.desktop),
    );
    expect(both.unrealProject).toBe(projectCandidates.documents);
    const none = await importWithoutOverrides(() => letOnlyExist());
    expect(none.unrealProject).toBe(projectCandidates.documents);
  });

  it('uses the second Unreal project candidate when the first is absent', async () => {
    const config = await importWithoutOverrides(() => letOnlyExist(projectCandidates.desktop));
    expect(config.unrealProject).toBe(projectCandidates.desktop);
  });

  it('finds the newest matching winget ffmpeg build and names both tools', async () => {
    const config = await importWithoutOverrides(() => {
      letOnlyExist(wingetRoot);
      wingetLists(['ffmpeg-8.1.0-full_build', 'ffmpeg-8.2-full_build']);
    });
    expect(config.ffmpegExe).toBe(`${wingetRoot}\\ffmpeg-8.2-full_build\\bin\\ffmpeg.exe`);
    expect(config.ffprobeExe).toBe(`${wingetRoot}\\ffmpeg-8.2-full_build\\bin\\ffprobe.exe`);
  });

  it('ranks ffmpeg 10.0 above 8.1.1 by numeric version', async () => {
    const config = await importWithoutOverrides(() => {
      letOnlyExist(wingetRoot);
      wingetLists(['ffmpeg-10.0-full_build', 'ffmpeg-8.1.1-full_build']);
    });
    expect(config.ffmpegExe).toBe(`${wingetRoot}\\ffmpeg-10.0-full_build\\bin\\ffmpeg.exe`);
  });

  it('keeps folder names that are not exact full builds out of the winget scan', async () => {
    const config = await importWithoutOverrides(() => {
      letOnlyExist(wingetRoot);
      wingetLists(['ffmpeg-8.1-full_build', 'ffmpeg-8.2.0-full_build-BETA', 'ffmpeg-8.2.0-shared']);
    });
    expect(config.ffmpegExe).toBe(`${wingetRoot}\\ffmpeg-8.1-full_build\\bin\\ffmpeg.exe`);
  });

  it('names the documented default build when the winget folder is missing', async () => {
    const config = await importWithoutOverrides(() => letOnlyExist());
    expect(config.ffmpegExe).toBe(`${wingetRoot}\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe`);
  });

  it('names the documented default build when the winget folder has no matching build', async () => {
    const config = await importWithoutOverrides(() => {
      letOnlyExist(wingetRoot);
      wingetLists(['notes.txt']);
    });
    expect(config.ffmpegExe).toBe(`${wingetRoot}\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe`);
  });
});
