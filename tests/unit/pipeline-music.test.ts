import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
  SAMPLE_RATE,
  TRACK_IDS,
  cleanupScriptedModules,
  contentMusic,
  ffmpegExe,
  ffprobeExe,
  fileCalls,
  loudnessReport,
  loopWav,
  m4aFile,
  normWav,
  oggFile,
  resetScenario,
  runMusicPipeline,
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
