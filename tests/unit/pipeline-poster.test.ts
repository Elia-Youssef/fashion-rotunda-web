import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// pipeline/poster.mjs is a top-level program: importing it runs the whole encode, so every binary
// it would start and every file API it would touch is replaced here, the same scripted-module
// pattern the other pipeline suites use. A test sets what it varies on `scenario`, calls
// runPoster(), and reads the recorded spawns, file calls, console output and thrown error.

// Sentinel machine layout handed to the script by the mocked config module. Nothing under it
// exists; every file API is intercepted, so the paths only have to be well formed.
const fixtureRoot = resolve('fashion-rotunda-poster-fixture');
const ffmpegExe = resolve(fixtureRoot, 'tools', 'ffmpeg.exe');
const sourceJpg = resolve(fixtureRoot, 'public', 'poster', 'hero.jpg');
const posterDir = resolve(fixtureRoot, 'public', 'poster');
const defaultOutput = resolve(posterDir, 'hero-phone.jpg');

interface SpawnRecord {
  exe: string;
  args: string[];
  options: unknown;
}

const spawnCalls: SpawnRecord[] = [];
const fileCalls = {
  mkdir: [] as Array<{ path: string; options: unknown }>,
  stat: [] as string[],
};

// One scenario per import of the script; resetScenario() restores the healthy encode.
const scenario = {
  exitStatus: 0 as number | null,
  stderr: '',
  spawnError: undefined as Error | undefined,
  size: 84_000,
};

function scriptedSpawnSync(exe: string, args: string[], options: unknown) {
  spawnCalls.push({ exe, args, options });
  if (scenario.spawnError) {
    return { error: scenario.spawnError, status: null };
  }
  return { error: undefined, status: scenario.exitStatus, stderr: scenario.stderr };
}

function installScriptedModules() {
  vi.doMock('node:child_process', async (importOriginal) => {
    const original = (await importOriginal()) as Record<string, unknown>;
    return { ...original, spawnSync: scriptedSpawnSync };
  });
  vi.doMock('node:fs', async (importOriginal) => {
    const original = (await importOriginal()) as Record<string, unknown>;
    return {
      ...original,
      mkdirSync: (path: string, options?: object) => {
        fileCalls.mkdir.push({ path, options });
        return undefined;
      },
      statSync: (path: string) => {
        fileCalls.stat.push(path);
        return { size: scenario.size };
      },
    };
  });
  vi.doMock('../../pipeline/config.mjs', () => ({
    ffmpegExe,
    root: fixtureRoot,
  }));
}

const MOCKED_MODULES = ['node:child_process', 'node:fs', '../../pipeline/config.mjs'];

function resetScenario() {
  scenario.exitStatus = 0;
  scenario.stderr = '';
  scenario.spawnError = undefined;
  scenario.size = 84_000;
  spawnCalls.length = 0;
  fileCalls.mkdir.length = 0;
  fileCalls.stat.length = 0;
}

async function cleanupScriptedModules() {
  vi.restoreAllMocks();
  for (const id of MOCKED_MODULES) vi.doUnmock(id);
  vi.resetModules();
}

interface PosterRun {
  thrown: unknown;
  logs: string[];
}

/** Imports the script once under the scripted modules and records everything it does. */
async function runPoster(cliArgs: readonly string[] = []): Promise<PosterRun> {
  installScriptedModules();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const previousArgv = process.argv;
  process.argv = ['node', 'pipeline/poster.mjs', ...cliArgs];
  vi.resetModules();
  let thrown: unknown;
  try {
    // @ts-expect-error The pipeline script has no typed exports; these tests exercise its top-level side effects.
    await import('../../pipeline/poster.mjs');
  } catch (caught) {
    thrown = caught;
  } finally {
    process.argv = previousArgv;
  }
  const logs = log.mock.calls.map((call) => call.map(String).join(' '));
  return { thrown, logs };
}

function errorMessage(thrown: unknown): string {
  expect(thrown).toBeInstanceOf(Error);
  return (thrown as Error).message;
}

beforeEach(resetScenario);
afterEach(cleanupScriptedModules);

describe('phone poster script', () => {
  it('encodes the default phone still with the pinned ffmpeg argv', async () => {
    const { thrown, logs } = await runPoster();
    expect(thrown).toBeUndefined();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.exe).toBe(ffmpegExe);
    expect(spawnCalls[0]?.args).toEqual([
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      sourceJpg,
      '-map_metadata',
      '-1',
      '-frames:v',
      '1',
      '-vf',
      'scale=960:-2:flags=lanczos',
      '-c:v',
      'mjpeg',
      '-q:v',
      '5',
      '-pix_fmt',
      'yuvj420p',
      '-threads',
      '1',
      '-fflags',
      '+bitexact',
      '-flags:v',
      '+bitexact',
      defaultOutput,
    ]);
    expect(spawnCalls[0]?.options).toEqual({ encoding: 'utf8' });
    expect(fileCalls.mkdir).toEqual([{ path: posterDir, options: { recursive: true } }]);
    expect(fileCalls.stat).toEqual([defaultOutput]);
    expect(logs).toEqual([`phone poster: ${scenario.size} bytes, width 960 -> ${defaultOutput}`]);
  });

  it('writes a --out target where the caller points it', async () => {
    const output = resolve(fixtureRoot, 'assets-src', 'work', 'poster', 'hero-phone-custom.jpg');
    const { thrown } = await runPoster(['--out', output]);
    expect(thrown).toBeUndefined();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args.at(-1)).toBe(output);
    expect(fileCalls.mkdir[0]?.path).toBe(resolve(fixtureRoot, 'assets-src', 'work', 'poster'));
  });

  it('refuses to overwrite the full poster, case insensitively', async () => {
    for (const output of [sourceJpg, sourceJpg.toUpperCase()]) {
      const { thrown } = await runPoster(['--out', output]);
      expect(errorMessage(thrown)).toBe('The full poster is read-only');
      expect(spawnCalls).toHaveLength(0);
    }
  });

  it('rejects argv it does not understand with the usage line', async () => {
    for (const badArgs of [['--out'], ['--output', 'x.jpg'], ['extra'], ['--out', 'a.jpg', 'b.jpg']]) {
      const { thrown } = await runPoster(badArgs);
      expect(errorMessage(thrown)).toBe('Usage: node pipeline/poster.mjs [--out FILE]');
      expect(spawnCalls).toHaveLength(0);
    }
  });

  it('reports a tool it cannot start by rethrowing the spawn error', async () => {
    scenario.spawnError = new Error('spawn ffmpeg-mock ENOENT');
    const { thrown } = await runPoster();
    expect(errorMessage(thrown)).toBe('spawn ffmpeg-mock ENOENT');
  });

  it('reports a failed encode with its exit status and stderr', async () => {
    scenario.exitStatus = 1;
    scenario.stderr = 'simulated encoder failure';
    const { thrown } = await runPoster();
    expect(errorMessage(thrown)).toBe('Poster encoding failed (1): simulated encoder failure');
  });

  it('accepts a poster exactly at the byte limit and rejects one over it', async () => {
    scenario.size = 100_000;
    const atLimit = await runPoster();
    expect(atLimit.thrown).toBeUndefined();
    scenario.size = 100_001;
    const over = await runPoster();
    expect(errorMessage(over.thrown)).toBe('Phone poster is 100001 bytes, limit 100000');
  });
});
