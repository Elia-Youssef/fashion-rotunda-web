import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  APPLIED_OUTPUT_I,
  BOUNDARY_STEP,
  CROSSFADE_FRAMES,
  CUT_FRAMES,
  DURATION,
  ENCODED_BYTES,
  HEAD_FRAMES,
  LOOP_FRAMES,
  MEASURED_LOUDNESS,
  MS_FRAMES,
  SAMPLE_RATE,
  SEAM_FRAMES,
  TRACK_IDS,
  TRIMMED_FRAMES,
  cleanupScriptedModules,
  contentMusic,
  ffmpegExe,
  ffprobeExe,
  fileCalls,
  installScriptedModules,
  loudnessReport,
  loopPcm,
  loopWav,
  m4aFile,
  normWav,
  oggFile,
  resetScenario,
  runMusicPipeline,
  sampleAt,
  scriptedSpawnSync,
  scenario,
  sourceWav,
  spawnCalls,
  trimWav,
  workMusic,
  type PipelineRun,
} from '../support/pipeline-music';

// The music pipeline's tool contracts, run end to end against scripted ffmpeg and ffprobe
// responses: no binary starts, no real path is touched. The recorded spawn arguments pin what the
// pipeline asks each tool to do, and the synthetic samples pin the seam proof's arithmetic at the
// frame the page wraps at.

// The script's loudness and encoding targets, mirrored: one loudness for every track, headroom
// under 0 dBFS, the LRA loudnorm is asked to hold, and the two codec budgets.
const TARGET_LUFS = -18;
const TRUE_PEAK_DB = -1.5;
const LOUDNESS_RANGE = 11;
const OPUS_KBPS = 96;
const AAC_KBPS = 128;

// The silence trim runs the same filter from each end: silenceremove only trims a start, so the
// tail is trimmed reversed. start_silence keeps 0.1 s so the cut avoids a rising edge.
const SILENCE = 'silenceremove=start_periods=1:start_threshold=-60dB:start_silence=0.1';

// The loudnorm target string, before and with the measured values applied.
const LOUDNORM_TARGET = `loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK_DB}:LRA=${LOUDNESS_RANGE}`;
const LOUDNORM_APPLIED =
  `${LOUDNORM_TARGET}:measured_I=${MEASURED_LOUDNESS.input_i}` +
  `:measured_TP=${MEASURED_LOUDNESS.input_tp}:measured_LRA=${MEASURED_LOUDNESS.input_lra}` +
  `:measured_thresh=${MEASURED_LOUDNESS.input_thresh}:offset=${MEASURED_LOUDNESS.target_offset}` +
  ':linear=true:print_format=json';

// The cut, split and crossfade graph: the trimmed source cut to whole milliseconds, head and tail
// split at 8 s, the tail crossfaded linearly into the head.
const LOOP_GRAPH =
  `[0:a]atrim=end_sample=${CUT_FRAMES},asetpts=PTS-STARTPTS,asplit=2[whole1][whole2];` +
  `[whole1]atrim=end_sample=${HEAD_FRAMES},asetpts=PTS-STARTPTS[head];` +
  `[whole2]atrim=start_sample=${HEAD_FRAMES},asetpts=PTS-STARTPTS[tail];` +
  `[tail][head]acrossfade=ns=${CROSSFADE_FRAMES}:c1=tri:c2=tri[out]`;

// Each track makes nine tool runs: duration probe, trim, frame probe, loop build, two loudness
// passes, two encodes, seam decode.
const CALLS_PER_TRACK = 9;

// The printed per-track line, and its parsed shape for track 01. The printout separates its
// fields with two spaces; the regex writes each gap as {2} so the count stays visible.
const TRACK_LINE =
  /^music-(\d{2}) {2}loop (\d+\.\d{3}) s \((\d+) frames\) {2}loudness (-?\d+\.\d) -> (-?\d+\.\d) LUFS {2}seam (\d+\.\d{4}) <= 1\.5x (\d+\.\d{4}) {2}opus (\d+) B {2}aac (\d+) B$/;

let run: PipelineRun;
let parseLoudnessJson: (stderr: Buffer | string) => Record<string, unknown> | null;

beforeAll(async () => {
  resetScenario();
  run = await runMusicPipeline();
  // @ts-expect-error The pipeline script has no typed exports; the tests read its exported parser.
  ({ parseLoudnessJson } = (await import('../../pipeline/audio/music.mjs')) as {
    parseLoudnessJson: (stderr: Buffer | string) => Record<string, unknown> | null;
  });
});

afterAll(cleanupScriptedModules);

describe('music pipeline run', () => {
  it('processes all seven tracks without starting a real tool or exiting', () => {
    expect(run.thrown).toBeUndefined();
    expect(run.exitCodes).toEqual([]);
    expect(run.errors).toEqual([]);
    expect(spawnCalls).toHaveLength(TRACK_IDS.length * CALLS_PER_TRACK);
  });

  it('probes the source duration through ffprobe', () => {
    expect(spawnCalls[0]).toEqual({
      exe: ffprobeExe,
      args: ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', sourceWav('01')],
    });
  });

  it('trims silence off both ends and resamples to 48 kHz in one run', () => {
    expect(spawnCalls[1]).toEqual({
      exe: ffmpegExe,
      args: [
        '-y', '-i', sourceWav('01'),
        '-af', `${SILENCE},areverse,${SILENCE},areverse`,
        '-ar', String(SAMPLE_RATE),
        trimWav('01'),
      ],
    });
  });

  it('counts the trim in frames by key, whatever order ffprobe prints', () => {
    expect(spawnCalls[2]).toEqual({
      exe: ffprobeExe,
      args: [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=duration_ts,time_base',
        '-of', 'default=nw=1',
        trimWav('01'),
      ],
    });
  });

  it('builds the loop by crossfading the tail into the head in one graph', () => {
    expect(spawnCalls[3]).toEqual({
      exe: ffmpegExe,
      args: [
        '-y', '-i', trimWav('01'),
        '-filter_complex', LOOP_GRAPH,
        '-map', '[out]',
        '-ar', String(SAMPLE_RATE),
        loopWav('01'),
      ],
    });
  });

  it('measures loudness first, with print_format=json on stderr', () => {
    expect(spawnCalls[4]).toEqual({
      exe: ffmpegExe,
      args: ['-i', loopWav('01'), '-af', `${LOUDNORM_TARGET}:print_format=json`, '-f', 'null', '-'],
    });
  });

  it('applies the measured values verbatim as one linear gain', () => {
    expect(spawnCalls[5]).toEqual({
      exe: ffmpegExe,
      args: ['-y', '-i', loopWav('01'), '-af', LOUDNORM_APPLIED, '-ar', String(SAMPLE_RATE), normWav('01')],
    });
  });

  it('encodes opus and aac from the normalized loop', () => {
    expect(spawnCalls[6]).toEqual({
      exe: ffmpegExe,
      args: [
        '-y', '-i', normWav('01'),
        '-c:a', 'libopus', '-b:a', `${OPUS_KBPS}k`, '-vbr', 'on', '-application', 'audio',
        '-f', 'ogg', oggFile('01'),
      ],
    });
    expect(spawnCalls[7]).toEqual({
      exe: ffmpegExe,
      args: [
        '-y', '-i', normWav('01'),
        '-c:a', 'aac', '-b:a', `${AAC_KBPS}k`, '-movflags', '+faststart',
        m4aFile('01'),
      ],
    });
  });

  it('decodes the seam proof to raw stereo floats at 48 kHz', () => {
    expect(spawnCalls[8]).toEqual({
      exe: ffmpegExe,
      args: ['-i', normWav('01'), '-f', 'f32le', '-ac', '2', '-ar', String(SAMPLE_RATE), '-'],
    });
  });

  it('repeats the whole chain for every track with its own file names', () => {
    for (const id of TRACK_IDS.slice(1)) {
      const base = TRACK_IDS.indexOf(id) * CALLS_PER_TRACK;
      expect(spawnCalls[base + 1].args).toContain(sourceWav(id));
      expect(spawnCalls[base + 2].args).toContain(trimWav(id));
      expect(spawnCalls[base + 6].args).toContain(oggFile(id));
      expect(spawnCalls[base + 7].args).toContain(m4aFile(id));
      expect(spawnCalls[base + 8].args).toContain(normWav(id));
    }
  });
});

describe('music pipeline files', () => {
  it('creates the work and content music directories first', () => {
    expect(fileCalls.mkdir).toEqual([
      { path: workMusic, options: { recursive: true } },
      { path: contentMusic, options: { recursive: true } },
    ]);
  });

  it('copies only the shipped track into content', () => {
    expect(fileCalls.copy).toEqual([
      { from: oggFile('01'), to: resolve(contentMusic, 'music-01.ogg') },
      { from: m4aFile('01'), to: resolve(contentMusic, 'music-01.m4a') },
    ]);
  });

  it('sizes every encoded file of every track', () => {
    expect(fileCalls.stat).toEqual(
      TRACK_IDS.flatMap((id) => [oggFile(id), m4aFile(id)]),
    );
  });

  it('writes one manifest naming the shipped track only', () => {
    expect(fileCalls.write).toEqual([
      {
        path: resolve(contentMusic, 'music.json'),
        text: expect.any(String),
        encoding: 'utf8',
      },
    ]);
    const manifest = JSON.parse(fileCalls.write[0].text) as Record<string, unknown>;
    expect(manifest).toEqual({
      version: 1,
      default: 'music-01',
      tracks: [
        {
          id: 'music-01',
          title: 'Track 1',
          source: 'Music01.WAV',
          duration: DURATION,
          loudness: {
            input: Math.round(Number(MEASURED_LOUDNESS.input_i) * 10) / 10,
            output: Math.round(Number(APPLIED_OUTPUT_I) * 10) / 10,
          },
          seam: {
            boundaryStep: Math.round(BOUNDARY_STEP * 10000) / 10000,
            reference: Math.round(BOUNDARY_STEP * 10000) / 10000,
          },
          sources: [
            { url: 'music-01.ogg', type: 'audio/ogg; codecs="opus"', bytes: ENCODED_BYTES },
            { url: 'music-01.m4a', type: 'audio/mp4; codecs="mp4a.40.2"', bytes: ENCODED_BYTES },
          ],
        },
      ],
    });
  });
});

describe('music pipeline printout', () => {
  it('prints one measured line per track and a manifest summary', () => {
    expect(run.logs).toHaveLength(TRACK_IDS.length + 1);
    const parsed = run.logs.slice(0, -1).map((entry) => entry.match(TRACK_LINE));
    expect(parsed.every((match) => match !== null)).toBe(true);
    expect(parsed.map((match) => match?.[1])).toEqual(TRACK_IDS);
    const first = parsed[0] ?? [];
    expect(first[2]).toBe(DURATION.toFixed(3));
    expect(first[3]).toBe(String(LOOP_FRAMES));
    expect(first[4]).toBe(Number(MEASURED_LOUDNESS.input_i).toFixed(1));
    expect(first[5]).toBe(Number(APPLIED_OUTPUT_I).toFixed(1));
    expect(first[8]).toBe(String(ENCODED_BYTES));
    expect(first[9]).toBe(String(ENCODED_BYTES));
    expect(run.logs.at(-1)).toBe(`music: wrote 1 track(s) to ${resolve(contentMusic, 'music.json')}`);
  });

  it('certifies the seam at a boundary step the windows can explain', () => {
    const first = (run.logs[0]?.match(TRACK_LINE) ?? []);
    const boundary = Number(first[6]);
    const reference = Number(first[7]);
    // The continuous loop's boundary step is exactly its loudest in-window step; the square wave
    // in the middle (steps of 10) must never appear in the reference.
    expect(Math.abs(boundary - BOUNDARY_STEP)).toBeLessThanOrEqual(0.0002);
    expect(Math.abs(reference - BOUNDARY_STEP)).toBeLessThanOrEqual(0.0002);
    expect(reference).toBeLessThan(1);
    expect(boundary).toBeLessThanOrEqual(1.5 * reference);
  });
});

describe('parseLoudnessJson', () => {
  it('reads the measured block out of loudnorm stderr noise', () => {
    expect(parseLoudnessJson(Buffer.from(loudnessReport(MEASURED_LOUDNESS)))).toEqual({
      ...MEASURED_LOUDNESS,
    });
  });

  it('reads a plain string as well as a buffer', () => {
    expect(parseLoudnessJson(loudnessReport(MEASURED_LOUDNESS))).toEqual({ ...MEASURED_LOUDNESS });
  });

  it('returns null when stderr carries no JSON block', () => {
    expect(parseLoudnessJson('no measurements at all')).toBeNull();
    expect(parseLoudnessJson(Buffer.alloc(0))).toBeNull();
  });

  it('returns null when the block is not valid JSON', () => {
    expect(parseLoudnessJson('{ "input_i": -15.3, }')).toBeNull();
  });

  it('returns null when the block carries no input loudness', () => {
    expect(parseLoudnessJson('{ "output_i": "-18.0" }')).toBeNull();
  });

  it('skips a block that lacks the measurement and reads the next', () => {
    const stderr = `{ "stage": "pass 1" }\nnoise\n${JSON.stringify(MEASURED_LOUDNESS)}`;
    expect(parseLoudnessJson(stderr)).toEqual({ ...MEASURED_LOUDNESS });
  });
});

// The decisions the pinned tool arguments alone cannot see: which arm of a guard fired, which
// channel a reported number came from, how large a buffer or window a step of the proof really
// spans, and which exact strings ride into the second loudness pass. Each test scripts one
// scenario that separates the real decision from its nearest plausible mistake.

// A frame near the two-thirds point of the head window: inside the certified window, outside a
// half-size one, and clear of the wrap-adjacent steps that every window size still sees.
const WITNESS_FRAME = 4001;
// The wrap is reached by a ramp this long, adding or removing RAMP_SPAN by the last frame, so the
// boundary step is large while every step inside the ramp stays far below the sine's own maximum.
const RAMP_FRAMES = 100;
const RAMP_SPAN = 0.5;

function overrideSample(pcm: Buffer, frame: number, channel: number, value: number): void {
  pcm.writeFloatLE(value, frame * 8 + channel * 4);
}

/** The healthy loop with one channel's wrap reached by a quiet ramp instead of the sine's own step. */
function rampedWrapPcm(channel: number, direction: 1 | -1): Buffer {
  const pcm = loopPcm();
  for (let i = 0; i < RAMP_FRAMES; i += 1) {
    const frame = LOOP_FRAMES - RAMP_FRAMES + i;
    overrideSample(
      pcm,
      frame,
      channel,
      sampleAt(frame) + (direction * ((i + 1) * RAMP_SPAN)) / RAMP_FRAMES,
    );
  }
  return pcm;
}

/** The loudest step a one-frame spike at `frame` adds to both of its neighbouring steps. */
function spikeSteps(frame: number): number {
  return Math.max(
    Math.abs(sampleAt(frame + 1) - sampleAt(frame) - 1),
    Math.abs(sampleAt(frame) + 1 - sampleAt(frame - 1)),
  );
}

/** The reference of a ramped channel: the sine's own maximum plus the ramp's per-frame share. */
function rampedChannelReference(): number {
  let max = BOUNDARY_STEP;
  for (let frame = LOOP_FRAMES - RAMP_FRAMES - 1; frame < LOOP_FRAMES - 1; frame += 1) {
    max = Math.max(max, Math.abs(sampleAt(frame + 1) - sampleAt(frame) + RAMP_SPAN / RAMP_FRAMES));
  }
  return max;
}

/** Runs the script once with the spawn options recorded beside the scripted tool responses. */
async function runMusicPipelineRecordingSpawnOptions() {
  const recorded: Array<{ exe: string; args: string[]; options: unknown }> = [];
  installScriptedModules();
  vi.doMock('node:child_process', async (importOriginal) => {
    const original = (await importOriginal()) as Record<string, unknown>;
    return {
      ...original,
      spawnSync: (exe: string, args: string[], options: unknown) => {
        recorded.push({ exe, args, options });
        return scriptedSpawnSync(exe, args);
      },
    };
  });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
    throw new Error(`process exit ${String(code)}`);
  }) as typeof process.exit);
  vi.resetModules();
  let thrown: unknown;
  try {
    // @ts-expect-error The pipeline script has no typed exports; these tests exercise its top-level side effects.
    await import('../../pipeline/audio/music.mjs');
  } catch (caught) {
    thrown = caught;
  }
  return { thrown, recorded };
}

describe('music pipeline guarded decisions', () => {
  beforeEach(resetScenario);
  afterEach(cleanupScriptedModules);

  it('rejects a duration ffprobe cannot parse as a number at all', async () => {
    scenario.probeDuration = 'n/a';
    const guarded = await runMusicPipeline();
    expect(guarded.exitCodes).toEqual([1]);
    expect(guarded.errors).toEqual([
      `music: probe ${sourceWav('01')}: duration is not a positive number`,
    ]);
    expect(spawnCalls).toHaveLength(1);
  });

  it('rejects a frame count of zero before the loop arithmetic runs', async () => {
    scenario.probeFrames = `time_base=1/${SAMPLE_RATE}\nduration_ts=0`;
    const guarded = await runMusicPipeline();
    expect(guarded.exitCodes).toEqual([1]);
    expect(guarded.errors).toEqual([
      `music: frames ${trimWav('01')}: duration_ts is not a positive whole number of frames`,
    ]);
    expect(spawnCalls).toHaveLength(3);
  });

  it('reads the frame probe fields by key whatever order ffprobe prints', async () => {
    scenario.probeFrames = `duration_ts=${TRIMMED_FRAMES}\ntime_base=1/${SAMPLE_RATE}`;
    const guarded = await runMusicPipeline();
    expect(guarded.thrown).toBeUndefined();
    expect(guarded.exitCodes).toEqual([]);
    const manifest = JSON.parse(fileCalls.write[0].text) as { tracks: Array<{ duration: number }> };
    expect(manifest.tracks[0].duration).toBe(DURATION);
  });

  it('rejects a cut that leaves exactly the crossfade with no tail', async () => {
    const exactlyHeadAndFade = HEAD_FRAMES + CROSSFADE_FRAMES;
    scenario.probeFrames = `time_base=1/${SAMPLE_RATE}\nduration_ts=${exactlyHeadAndFade}`;
    const guarded = await runMusicPipeline();
    expect(guarded.exitCodes).toEqual([1]);
    expect(guarded.errors).toEqual([
      `music: loop music-01: ${exactlyHeadAndFade} frames leaves no tail to crossfade into the head`,
    ]);
    expect(spawnCalls).toHaveLength(3);
  });

  it('rejects a second loudness pass that prints no measured block', async () => {
    scenario.loudnessPass2 = 'pass 2 wrote nothing usable';
    const guarded = await runMusicPipeline();
    expect(guarded.exitCodes).toEqual([1]);
    expect(guarded.errors).toEqual([
      `music: loudness pass 2 ${loopWav('01')}: no measured JSON block on stderr`,
      'pass 2 wrote nothing usable',
    ]);
    expect(spawnCalls).toHaveLength(6);
  });

  it('passes the measured loudness strings through without reformatting', async () => {
    scenario.loudnessPass1 = loudnessReport({
      input_i: '-15.340',
      input_tp: '-0.870',
      input_lra: '8.410',
      input_thresh: '-26.130',
      target_offset: '0.310',
    });
    const guarded = await runMusicPipeline();
    expect(guarded.thrown).toBeUndefined();
    const applied = spawnCalls.find((call) => call.args.some((arg) => arg.includes('measured_I=')));
    expect(applied?.args).toContain(
      `loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK_DB}:LRA=${LOUDNESS_RANGE}` +
        ':measured_I=-15.340:measured_TP=-0.870:measured_LRA=8.410' +
        ':measured_thresh=-26.130:offset=0.310:linear=true:print_format=json',
    );
  });

  it('decodes the seam proof with a buffer that fits the whole loop', async () => {
    const { thrown, recorded } = await runMusicPipelineRecordingSpawnOptions();
    expect(thrown).toBeUndefined();
    expect(recorded).toHaveLength(TRACK_IDS.length * CALLS_PER_TRACK);
    const decodes = recorded.filter((call) => call.args.includes('f32le'));
    expect(decodes).toHaveLength(TRACK_IDS.length);
    for (const call of decodes) {
      expect(call.options).toEqual({ encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 });
    }
  });

  it('rejects a decode up to a window short of the loop', async () => {
    scenario.pcm = loopPcm(LOOP_FRAMES - MS_FRAMES);
    const guarded = await runMusicPipeline();
    expect(guarded.exitCodes).toEqual([1]);
    expect(guarded.errors).toEqual([
      `music: seam decode ${normWav('01')}: ${LOOP_FRAMES - MS_FRAMES} frames is shorter than the ` +
        `${LOOP_FRAMES}-frame loop`,
    ]);
    expect(spawnCalls).toHaveLength(9);
  });

  it('rejects a wrap that steps down, not just up', async () => {
    scenario.pcm = rampedWrapPcm(0, -1);
    const guarded = await runMusicPipeline();
    expect(guarded.exitCodes).toEqual([1]);
    const boundary = Math.abs(sampleAt(LOOP_FRAMES - 1) - RAMP_SPAN - sampleAt(0));
    expect(guarded.errors).toEqual([
      `music: seam check music-01 channel 0: boundary step ${boundary.toFixed(4)}` +
        ` exceeds 1.5x reference ${rampedChannelReference().toFixed(4)}`,
    ]);
    expect(spawnCalls).toHaveLength(9);
  });

  it('counts a falling step in the reference as loudly as a rising one', async () => {
    const pcm = rampedWrapPcm(1, 1);
    // Channel 1 drops one unit inside the head window and holds that level to the window's edge,
    // so the only large step the windows can see is a falling one; the recovery outside the
    // window is never measured.
    for (let frame = WITNESS_FRAME; frame < SEAM_FRAMES; frame += 1) {
      overrideSample(pcm, frame, 1, sampleAt(frame) - 1);
    }
    scenario.pcm = pcm;
    const guarded = await runMusicPipeline();
    expect(guarded.thrown).toBeUndefined();
    const manifest = JSON.parse(fileCalls.write[0].text) as {
      tracks: Array<{ seam: { boundaryStep: number; reference: number } }>;
    };
    const drop = Math.abs(sampleAt(WITNESS_FRAME) - 1 - sampleAt(WITNESS_FRAME - 1));
    expect(manifest.tracks[0].seam.reference).toBe(Math.round(drop * 10000) / 10000);
    expect(manifest.tracks[0].seam.boundaryStep).toBe(
      Math.round(Math.abs(sampleAt(LOOP_FRAMES - 1) + RAMP_SPAN - sampleAt(0)) * 10000) / 10000,
    );
  });

  it('judges each channel of the seam against its own reference', async () => {
    const pcm = rampedWrapPcm(1, 1);
    overrideSample(pcm, WITNESS_FRAME, 0, sampleAt(WITNESS_FRAME) + 1);
    scenario.pcm = pcm;
    const guarded = await runMusicPipeline();
    expect(guarded.exitCodes).toEqual([1]);
    const boundary = Math.abs(sampleAt(LOOP_FRAMES - 1) + RAMP_SPAN - sampleAt(0));
    expect(guarded.errors).toEqual([
      `music: seam check music-01 channel 1: boundary step ${boundary.toFixed(4)}` +
        ` exceeds 1.5x reference ${rampedChannelReference().toFixed(4)}`,
    ]);
  });

  it('spans both full seam windows and reports the worse channel', async () => {
    const pcm = rampedWrapPcm(0, 1);
    // One spike in each window, both on channel 0: the head spike at the two-thirds point, the
    // tail spike the same distance from the wrap. A window shrunk on either side loses its spike,
    // the boundary ramp survives in every window size, and the certification flips to a rejection.
    overrideSample(pcm, WITNESS_FRAME, 0, sampleAt(WITNESS_FRAME) + 1);
    overrideSample(pcm, LOOP_FRAMES - WITNESS_FRAME, 0, sampleAt(LOOP_FRAMES - WITNESS_FRAME) + 1);
    scenario.pcm = pcm;
    const guarded = await runMusicPipeline();
    expect(guarded.thrown).toBeUndefined();
    const manifest = JSON.parse(fileCalls.write[0].text) as {
      tracks: Array<{ seam: { boundaryStep: number; reference: number } }>;
    };
    const boundary = Math.abs(sampleAt(LOOP_FRAMES - 1) + RAMP_SPAN - sampleAt(0));
    const spike = Math.max(spikeSteps(WITNESS_FRAME), spikeSteps(LOOP_FRAMES - WITNESS_FRAME));
    expect(manifest.tracks[0].seam).toEqual({
      boundaryStep: Math.round(boundary * 10000) / 10000,
      reference: Math.round(spike * 10000) / 10000,
    });
    // Numbers of this size only certify when both windows still span their full 0.1 s and the
    // reported figures come from channel 0, the louder channel.
    expect(manifest.tracks[0].seam.boundaryStep).toBeGreaterThan(0.4);
    expect(manifest.tracks[0].seam.reference).toBeGreaterThan(1);
  });
});
