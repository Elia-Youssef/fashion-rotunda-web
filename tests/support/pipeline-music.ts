import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { vi } from 'vitest';

// Scripted tool responses for the music pipeline's unit tests. pipeline/audio/music.mjs is a
// top-level program: importing it runs the whole seven-track pipeline, so every binary it would
// start and every file it would touch is replaced here. A test sets what it varies on `scenario`,
// calls runMusicPipeline(), and reads the recorded spawns, file calls and console output.

// Sentinel machine layout handed to the script by the mocked config module. Nothing under it
// exists; every file API is intercepted, so the paths only have to be well formed.
export const sourceDir = resolve('fashion-rotunda-music-fixture', 'assets-src', 'source');
export const workDir = resolve('fashion-rotunda-music-fixture', 'assets-src', 'work');
export const contentDir = resolve('fashion-rotunda-music-fixture', 'public', 'content');
export const ffmpegExe = resolve('fashion-rotunda-music-fixture', 'tools', 'ffmpeg.exe');
export const ffprobeExe = resolve('fashion-rotunda-music-fixture', 'tools', 'ffprobe.exe');

export const workMusic = resolve(workDir, 'music');
export const contentMusic = resolve(contentDir, 'music');

// The script's documented constants, mirrored: 48 kHz end to end, an 8 s intro head, a 4 s
// crossfade, one millisecond = 48 frames on the cut grid, and 4,800-frame (0.1 s) seam windows.
export const SAMPLE_RATE = 48000;
export const HEAD_FRAMES = 8 * SAMPLE_RATE;
export const CROSSFADE_FRAMES = 4 * SAMPLE_RATE;
export const MS_FRAMES = SAMPLE_RATE / 1000;
export const SEAM_FRAMES = 4800;

// Seven tracks are processed; track 01 is the shipped one, the other six are measured only.
export const TRACK_IDS = ['01', '02', '03', '04', '05', '06', '07'];

export function sourceWav(id: string) {
  return resolve(sourceDir, 'unreal', 'audio', 'Game', 'Audio', 'BackgroundMusic', `Music${id}.WAV`);
}
export function trimWav(id: string) {
  return resolve(workMusic, `music-${id}-trim.wav`);
}
export function loopWav(id: string) {
  return resolve(workMusic, `music-${id}-loop.wav`);
}
export function normWav(id: string) {
  return resolve(workMusic, `music-${id}-norm.wav`);
}
export function oggFile(id: string) {
  return resolve(workMusic, `music-${id}.ogg`);
}
export function m4aFile(id: string) {
  return resolve(workMusic, `music-${id}.m4a`);
}

// probeFrames' answer for a healthy trim: 576100 frames, not a whole number of milliseconds, so
// the script has to cut it to the grid itself. ffprobe prints in its own field order, so the text
// deliberately carries time_base first to hold the script to reading by key, not by position.
export const TRIMMED_FRAMES = 576100;

// The loop arithmetic the script must apply to that trim: cut down to whole milliseconds, then the
// crossfade's overlap off. 576096 - 192000 = 384096 frames = 8.002 s, exact at three decimals.
export const CUT_FRAMES = Math.floor(TRIMMED_FRAMES / MS_FRAMES) * MS_FRAMES;
export const LOOP_FRAMES = CUT_FRAMES - CROSSFADE_FRAMES;
export const DURATION = LOOP_FRAMES / SAMPLE_RATE;

// The loudness report loudnorm prints in a real run, kept as the strings ffmpeg emits: pass 2
// must carry them through verbatim, not re-rounded.
export const MEASURED_LOUDNESS = {
  input_i: '-15.34',
  input_tp: '-0.87',
  input_lra: '8.41',
  input_thresh: '-26.13',
  target_offset: '0.31',
};
export const APPLIED_OUTPUT_I = '-18.01';

// statSync's byte count for every encoded file.
export const ENCODED_BYTES = 84213;

// The certified loop's samples. Inside both seam windows the loop is a 48-frame sine (1 kHz at
// 48 kHz). Its steepest one-frame step is one frame past a zero crossing, and the boundary
// repeats exactly that step, so a continuous loop certifies at a ratio of exactly 1. The middle
// carries a square wave whose steps are far louder than anything in the windows: if the reference
// ever leaks outside the windows, the printed reference jumps and every seam assertion sees it.
const SINE_AMPLITUDE = 0.5;
const SINE_PERIOD_FRAMES = 48;
const SQUARE_AMPLITUDE = 5;
const SQUARE_HALF_PERIOD_FRAMES = 2400;

// The boundary step of the continuous loop: |sample(LAST) - sample(0)|, one sine step across
// the wrap, because 384096 is a whole number of 48-frame periods.
export const BOUNDARY_STEP = SINE_AMPLITUDE * Math.sin((2 * Math.PI * 1) / SINE_PERIOD_FRAMES);

export function sampleAt(frame: number): number {
  if (frame < SEAM_FRAMES || frame >= LOOP_FRAMES - SEAM_FRAMES) {
    return (
      SINE_AMPLITUDE * Math.sin((2 * Math.PI * (frame % SINE_PERIOD_FRAMES)) / SINE_PERIOD_FRAMES)
    );
  }
  return Math.floor(frame / SQUARE_HALF_PERIOD_FRAMES) % 2 === 0 ? SQUARE_AMPLITUDE : -SQUARE_AMPLITUDE;
}

/** Stereo f32le bytes holding `frames` frames of the loop, both channels identical. */
export function loopPcm(frames: number = LOOP_FRAMES): Buffer {
  const pcm = Buffer.alloc(frames * 8);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = sampleAt(frame < LOOP_FRAMES ? frame : frame - LOOP_FRAMES);
    pcm.writeFloatLE(value, frame * 8);
    pcm.writeFloatLE(value, frame * 8 + 4);
  }
  return pcm;
}

/**
 * The continuous loop with channel 1 of the whole tail window shifted up by 3.0. Differences
 * inside the windows cannot see a constant offset, so the printed reference stays at one sine
 * step, but the wrap joins the shifted tail to the unshifted head: a boundary step of about 3,
 * the click the seam check exists to catch.
 */
export function jumpedBoundaryPcm(): Buffer {
  const pcm = loopPcm();
  for (let frame = LOOP_FRAMES - SEAM_FRAMES; frame < LOOP_FRAMES; frame += 1) {
    pcm.writeFloatLE(sampleAt(frame) + 3, frame * 8 + 4);
  }
  return pcm;
}

/** A loudnorm stderr: the one JSON block amid the progress lines ffmpeg prints around it. */
export function loudnessReport(values: Record<string, string>): string {
  return [
    '[Parsed_loudnorm_0 @ 0x1] Progress line.',
    JSON.stringify(values),
    '[Parsed_loudnorm_0 @ 0x1] Another progress line.',
  ].join('\n');
}

export interface SpawnRecord {
  exe: string;
  args: string[];
}

export const spawnCalls: SpawnRecord[] = [];

export const fileCalls = {
  mkdir: [] as Array<{ path: string; options: unknown }>,
  copy: [] as Array<{ from: string; to: string }>,
  stat: [] as string[],
  write: [] as Array<{ path: string; text: string; encoding?: string | undefined }>,
};

// One scenario per import of the script; resetScenario() restores the healthy pipeline.
export const scenario = {
  probeDuration: '421.333',
  probeFrames: `time_base=1/${SAMPLE_RATE}\nduration_ts=${TRIMMED_FRAMES}`,
  loudnessPass1: loudnessReport(MEASURED_LOUDNESS),
  loudnessPass2: loudnessReport({ ...MEASURED_LOUDNESS, output_i: APPLIED_OUTPUT_I }),
  exitStatus: 0 as number | null,
  stderr: '',
  spawnError: undefined as Error | undefined,
  pcm: loopPcm(),
};

let cachedPcm: Buffer | undefined;
function continuousPcm(): Buffer {
  cachedPcm ??= loopPcm();
  return cachedPcm;
}

const empty = Buffer.alloc(0);

// One dispatcher per call shape the script makes, keyed by a stable token in its arguments.
function respond(args: string[]): { stdout: Buffer; stderr: Buffer } {
  if (args.includes('format=duration')) {
    return { stdout: Buffer.from(scenario.probeDuration, 'utf8'), stderr: empty };
  }
  if (args.some((arg) => arg.includes('duration_ts'))) {
    return { stdout: Buffer.from(scenario.probeFrames, 'utf8'), stderr: empty };
  }
  if (args.some((arg) => arg.includes('measured_I='))) {
    return { stdout: empty, stderr: Buffer.from(scenario.loudnessPass2, 'utf8') };
  }
  if (args.some((arg) => arg.includes('print_format=json'))) {
    return { stdout: empty, stderr: Buffer.from(scenario.loudnessPass1, 'utf8') };
  }
  if (args.some((arg) => arg.includes('silenceremove')) || args.includes('-filter_complex')) {
    return { stdout: empty, stderr: empty };
  }
  if (args.includes('libopus') || args.includes('aac')) {
    return { stdout: empty, stderr: empty };
  }
  if (args.includes('f32le')) {
    return { stdout: scenario.pcm, stderr: empty };
  }
  throw new Error(`unexpected spawn arguments: ${args.join(' ')}`);
}

export function scriptedSpawnSync(exe: string, args: string[]) {
  spawnCalls.push({ exe, args });
  if (exe !== ffmpegExe && exe !== ffprobeExe) {
    throw new Error(`unexpected executable: ${exe}`);
  }
  if (scenario.spawnError) {
    return { error: scenario.spawnError, status: null, stdout: empty, stderr: empty };
  }
  const out = respond(args);
  return {
    error: undefined,
    status: scenario.exitStatus,
    stdout: out.stdout,
    stderr: scenario.stderr === '' ? out.stderr : Buffer.from(scenario.stderr, 'utf8'),
  };
}

const MOCKED_MODULES = ['node:fs', 'node:child_process', '../../pipeline/config.mjs'];

/** Registers the interceptions; takes effect on the next import after vi.resetModules(). */
export function installScriptedModules() {
  vi.doMock('node:fs', async (importOriginal) => {
    const original = (await importOriginal()) as Record<string, unknown>;
    return {
      ...original,
      mkdirSync: (path: string, options?: object) => {
        fileCalls.mkdir.push({ path, options });
        return undefined;
      },
      copyFileSync: (from: string, to: string) => {
        fileCalls.copy.push({ from, to });
      },
      statSync: (path: string) => {
        fileCalls.stat.push(path);
        return { size: ENCODED_BYTES };
      },
      writeFileSync: (path: string, text: string, encoding?: string) => {
        fileCalls.write.push({ path, text, encoding });
      },
    };
  });
  vi.doMock('node:child_process', async (importOriginal) => {
    const original = (await importOriginal()) as Record<string, unknown>;
    return { ...original, spawnSync: scriptedSpawnSync };
  });
  vi.doMock('../../pipeline/config.mjs', () => ({
    contentDir,
    ffmpegExe,
    ffprobeExe,
    sourceDir,
    workDir,
  }));
}

export interface PipelineRun {
  thrown: unknown;
  exitCodes: Array<number | string | null | undefined>;
  logs: string[];
  errors: string[];
}

/** Imports the script once under the scripted modules and records everything it does. */
export async function runMusicPipeline(): Promise<PipelineRun> {
  installScriptedModules();
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const exit = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    throw new Error(`process exit ${String(code)}`);
  });
  vi.resetModules();
  let thrown: unknown;
  try {
    // @ts-expect-error The pipeline script has no typed exports; these tests exercise its top-level side effects.
    await import('../../pipeline/audio/music.mjs');
  } catch (caught) {
    thrown = caught;
  }
  return {
    thrown,
    exitCodes: exit.mock.calls.map((call) => call[0]),
    logs: log.mock.calls.map((call) => call.map(String).join(' ')),
    errors: error.mock.calls.map((call) => call.map(String).join(' ')),
  };
}

export function resetScenario() {
  scenario.probeDuration = '421.333';
  scenario.probeFrames = `time_base=1/${SAMPLE_RATE}\nduration_ts=${TRIMMED_FRAMES}`;
  scenario.loudnessPass1 = loudnessReport(MEASURED_LOUDNESS);
  scenario.loudnessPass2 = loudnessReport({ ...MEASURED_LOUDNESS, output_i: APPLIED_OUTPUT_I });
  scenario.exitStatus = 0;
  scenario.stderr = '';
  scenario.spawnError = undefined;
  scenario.pcm = continuousPcm();
  spawnCalls.length = 0;
  fileCalls.mkdir.length = 0;
  fileCalls.copy.length = 0;
  fileCalls.stat.length = 0;
  fileCalls.write.length = 0;
}

export async function cleanupScriptedModules() {
  vi.restoreAllMocks();
  for (const id of MOCKED_MODULES) vi.doUnmock(id);
  vi.resetModules();
}
