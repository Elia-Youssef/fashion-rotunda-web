// The music pipeline: every background track exported from the Unreal project becomes a seamless
// loop at one common loudness, encoded once for the Opus world and once for the AAC world, and the
// default ships with a manifest beside it. No track was authored as a loop: each ends in a fade-out
// or silence, so a plain loop would play half a second of nothing at every turn. The loop is built
// by crossfading the track's ending into its intro, which moves the only musical join into the
// middle of the file and leaves a sample-continuous boundary at the file's edge.
//
// The file, the manifest and the seam check name the same last sample. The page wraps at the
// manifest's `duration`, which JSON carries at three decimals, so a loop of any other length would
// wrap early and never reach the boundary this script certifies: measured on the first build, the
// played boundary stepped 1.5 to 2.2 times its own reference on four tracks while the file's own
// boundary passed. The cure is arithmetic: the trimmed source is cut to a whole number of
// milliseconds before the split, which makes the loop a whole number of milliseconds too, so
// `duration` is exact at three decimals and the certified sample is the one the page plays.
//
//   npm run pipeline:music
//
// Reads  <sourceDir>/unreal/audio/Game/Audio/BackgroundMusic/Music0N.WAV (never modified)
// Writes <workDir>/music/ (intermediates, git-ignored) and <contentDir>/music/ (shipped files).

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { contentDir, ffmpegExe, ffprobeExe, sourceDir, workDir } from '../config.mjs';
import { shippedJson } from '../gltf/lib/manifest.mjs';

// The intro slice carried across the seam. Long enough that the crossfade lands in music rather
// than in a track's very first attack, short enough that nothing the visitor hears as "the start"
// is delayed: 8 s keeps every intro of the seven tracks intact.
const HEAD_SECONDS = 8;
// The crossfade length. 4 s hides the fade-out each track ends with; shorter would let the ending's
// decay curve be heard as a dip once per loop.
const CROSSFADE_SECONDS = 4;
// One loudness for every track, so switching tracks (a later list edit) never moves the volume.
// -18 LUFS sits under the -14 LUFS of commercial streaming masters: background, not foreground.
const TARGET_LUFS = -18;
// Headroom under 0 dBFS for the MP4/AAC decode chain and the browser's own output path.
const TRUE_PEAK_DB = -1.5;
// The LRA target loudnorm is asked to hold; the measured LRA is passed through in pass 2 so the
// linear gain stays one constant.
const LOUDNESS_RANGE = 11;
// Opus at 96 kbps stereo is transparent for this material at half the bytes of 128.
const OPUS_KBPS = 96;
// AAC needs more bits for the same quality; 128 kbps is the floor for transparent stereo AAC.
const AAC_KBPS = 128;
// What the page ships. The other six are transcoded and measured but stay in the work dir until
// this list is edited.
const SHIPPED = ['music-01'];

const TRACKS = [
  { id: 'music-01', file: 'Music01.WAV', title: 'Track 1' },
  { id: 'music-02', file: 'Music02.WAV', title: 'Track 2' },
  { id: 'music-03', file: 'Music03.WAV', title: 'Track 3' },
  { id: 'music-04', file: 'Music04.WAV', title: 'Track 4' },
  { id: 'music-05', file: 'Music05.WAV', title: 'Track 5' },
  { id: 'music-06', file: 'Music06.WAV', title: 'Track 6' },
  { id: 'music-07', file: 'Music07.WAV', title: 'Track 7' },
];

const srcDir = resolve(sourceDir, 'unreal', 'audio', 'Game', 'Audio', 'BackgroundMusic');
const workMusic = resolve(workDir, 'music');
const contentMusic = resolve(contentDir, 'music');

// 48 kHz end to end. loudnorm upsamples to 192 kHz internally and would output that rate unless
// every one of its runs pins -ar 48000 back down.
const SAMPLE_RATE = 48000;
// The grid the trimmed source is cut to before the split: one millisecond, 48 frames. The loop is
// that cut minus the crossfade, so it is a whole number of milliseconds and the manifest's
// three-decimal `duration` names its exact last sample rather than one up to 47 frames earlier.
const MS_FRAMES = SAMPLE_RATE / 1000;
// The same two lengths counted in frames, so the graph and the loop arithmetic use one unit and
// no duration string has to be trusted to land on a sample boundary.
const HEAD_FRAMES = HEAD_SECONDS * SAMPLE_RATE;
const CROSSFADE_FRAMES = CROSSFADE_SECONDS * SAMPLE_RATE;
// The seam windows the check compares: 4,800 frames is 0.1 s at 48 kHz.
const SEAM_FRAMES = 4800;
// A boundary step within 1.5x the loudest step inside the windows cannot be heard as a click: the
// ear judges a discontinuity against the signal's own slope, not against zero.
const SEAM_RATIO = 1.5;
// The decoded f32 stream of the longest loop is about 50 MB; the default 1 MB buffer would refuse it.
const DECODE_MAX_BUFFER = 512 * 1024 * 1024;

function fail(what, stderr) {
  console.error(`music: ${what}`);
  if (stderr) {
    console.error(stderr.trim());
  }
  process.exit(1);
}

/** Runs one tool, exits with its stderr on any failure. Arguments as an array, never a shell. */
function run(exe, args, what, maxBuffer = 10 * 1024 * 1024) {
  const result = spawnSync(exe, args, { encoding: 'buffer', maxBuffer });
  if (result.error) {
    fail(`${what}: ${result.error.message}`, null);
  }
  if (result.status !== 0) {
    fail(`${what} (exit ${statusText(result.status)})`, result.stderr?.toString('utf8'));
  }
  return result;
}

/** Node reports a signal kill as status null; the signal name is the honest thing to print. */
function statusText(status) {
  return status === null ? 'signal' : String(status);
}

function probeDuration(wav) {
  const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav];
  const result = run(ffprobeExe, args, `probe ${wav}`);
  const duration = Number(result.stdout.toString('utf8').trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    fail(`probe ${wav}: duration is not a positive number`, null);
  }
  return duration;
}

/**
 * The exact frame count of a 48 kHz WAV. duration_ts is counted in time_base units and a WAV's
 * time_base is 1/sample_rate, so it is the sample count itself: no float seconds to round, which
 * is the whole point of cutting to a frame grid. nb_frames reads N/A on WAV, hence this route.
 */
function probeFrames(wav) {
  const args = [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=duration_ts,time_base',
    '-of', 'default=nw=1',
    wav,
  ];
  // Read by key: ffprobe prints the entries in its own field order, not in the order asked for.
  const text = run(ffprobeExe, args, `frames ${wav}`).stdout.toString('utf8');
  const fields = new Map(
    text
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const cut = line.indexOf('=');
        return [line.slice(0, cut), line.slice(cut + 1)];
      }),
  );
  const timeBase = fields.get('time_base');
  if (timeBase !== `1/${SAMPLE_RATE}`) {
    fail(`frames ${wav}: time_base ${timeBase} is not 1/${SAMPLE_RATE}`, null);
  }
  const frames = Number(fields.get('duration_ts'));
  if (!Number.isInteger(frames) || frames <= 0) {
    fail(`frames ${wav}: duration_ts is not a positive whole number of frames`, null);
  }
  return frames;
}

/**
 * Leading and trailing silence off, resampled to 48 kHz, nothing else. It is its own run because
 * the next step has to know how many frames the trimmed signal holds before it can cut it to the
 * millisecond grid. silenceremove only trims a start, so the tail is trimmed reversed;
 * start_silence keeps 0.1 s of the quiet so the cut does not land on a rising edge.
 */
function trimSilence(sourceWav, trimWav) {
  const silence = 'silenceremove=start_periods=1:start_threshold=-60dB:start_silence=0.1';
  run(
    ffmpegExe,
    [
      '-y', '-i', sourceWav,
      '-af', `${silence},areverse,${silence},areverse`,
      '-ar', String(SAMPLE_RATE),
      trimWav,
    ],
    `trim ${sourceWav}`,
  );
}

/**
 * Cut, split and crossfade in one graph, every length counted in samples:
 *   x = the trimmed source cut to cutFrames, a whole number of milliseconds
 *   head = x[0, 8 s], tail = x[8 s, end]
 *   loop = tail crossfaded (4 s, linear curves) into head
 * The loop's first sample is x at 8 s and its last is x just before 8 s, so the file boundary is
 * sample-continuous and the 4 s join of the ending into the intro happens mid-file, once per loop.
 * acrossfade overlaps the two streams, so the result is cutFrames - CROSSFADE_FRAMES long: a whole
 * number of milliseconds, because both terms are.
 */
function buildLoop(trimWav, cutFrames, loopWav) {
  const graph = [
    `[0:a]atrim=end_sample=${cutFrames},asetpts=PTS-STARTPTS,asplit=2[whole1][whole2]`,
    `[whole1]atrim=end_sample=${HEAD_FRAMES},asetpts=PTS-STARTPTS[head]`,
    `[whole2]atrim=start_sample=${HEAD_FRAMES},asetpts=PTS-STARTPTS[tail]`,
    `[tail][head]acrossfade=ns=${CROSSFADE_FRAMES}:c1=tri:c2=tri[out]`,
  ].join(';');
  run(
    ffmpegExe,
    [
      '-y', '-i', trimWav,
      '-filter_complex', graph,
      '-map', '[out]',
      '-ar', String(SAMPLE_RATE),
      loopWav,
    ],
    `loop ${trimWav}`,
  );
}

/** The measured block loudnorm prints with print_format=json, the only machine-readable output. */
function parseLoudnessJson(stderr) {
  const text = stderr.toString('utf8');
  const match = text.match(/\{[^{}]*"input_i"[^{}]*\}/s);
  if (match === null) {
    return null;
  }
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Two passes, so the gain is one constant. Pass 1 measures; pass 2 applies measured_I/TP/LRA/thresh
 * and offset with linear=true, which is a single static gain: nothing pumps across the loop. The
 * measured values are passed through as the strings loudnorm printed, not re-rounded numbers.
 */
function normalize(loopWav, normWav) {
  const target = `loudnorm=I=${TARGET_LUFS}:TP=${TRUE_PEAK_DB}:LRA=${LOUDNESS_RANGE}`;
  const first = run(
    ffmpegExe,
    ['-i', loopWav, '-af', `${target}:print_format=json`, '-f', 'null', '-'],
    `loudness pass 1 ${loopWav}`,
  );
  const measured = parseLoudnessJson(first.stderr);
  if (measured === null) {
    fail(`loudness pass 1 ${loopWav}: no measured JSON block on stderr`, first.stderr.toString('utf8'));
  }
  const second = run(
    ffmpegExe,
    [
      '-y',
      '-i',
      loopWav,
      '-af',
      `${target}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
        `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}` +
        `:offset=${measured.target_offset}:linear=true:print_format=json`,
      '-ar',
      String(SAMPLE_RATE),
      normWav,
    ],
    `loudness pass 2 ${loopWav}`,
  );
  const applied = parseLoudnessJson(second.stderr);
  if (applied === null) {
    fail(`loudness pass 2 ${loopWav}: no measured JSON block on stderr`, second.stderr.toString('utf8'));
  }
  return {
    inputLu: Number(measured.input_i),
    outputLu: Number(applied.output_i),
  };
}

function encode(normWav, oggFile, m4aFile) {
  run(
    ffmpegExe,
    [
      '-y', '-i', normWav,
      '-c:a', 'libopus', '-b:a', `${OPUS_KBPS}k`, '-vbr', 'on', '-application', 'audio',
      '-f', 'ogg', oggFile,
    ],
    `opus ${normWav}`,
  );
  run(
    ffmpegExe,
    ['-y', '-i', normWav, '-c:a', 'aac', '-b:a', `${AAC_KBPS}k`, '-movflags', '+faststart', m4aFile],
    `aac ${normWav}`,
  );
}

/**
 * The loop's proof, taken at the sample the page actually wraps at. The player sets loopEnd from
 * the manifest's duration, so the last played frame is loopFrames - 1, and that is the frame this
 * check compares against frame 0: certifying the file's own last frame instead would certify a
 * boundary the page never reaches, which is exactly how the first build passed while the played
 * boundary stepped up to 2.2 times its reference. Decoded to raw floats, the SEAM_FRAMES before
 * the wrap and the SEAM_FRAMES after it give, per channel, the boundary step and the reference
 * (the largest step between consecutive frames inside the two windows). Both channels must pass;
 * the worse one is what gets reported.
 */
function seamCheck(normWav, loopFrames) {
  const decoded = run(
    ffmpegExe,
    ['-i', normWav, '-f', 'f32le', '-ac', '2', '-ar', String(SAMPLE_RATE), '-'],
    `seam decode ${normWav}`,
    DECODE_MAX_BUFFER,
  );
  const bytes = decoded.stdout;
  if (bytes.length === 0 || bytes.length % 8 !== 0) {
    fail(`seam decode ${normWav}: ${bytes.length} bytes is not whole stereo frames`, null);
  }
  const frames = bytes.length / 8;
  if (frames < loopFrames) {
    fail(`seam decode ${normWav}: ${frames} frames is shorter than the ${loopFrames}-frame loop`, null);
  }
  if (loopFrames < SEAM_FRAMES * 2 + 2) {
    fail(`seam decode ${normWav}: a ${loopFrames}-frame loop is shorter than the two windows`, null);
  }
  const sample = (frame, channel) => bytes.readFloatLE(frame * 8 + channel * 4);
  const last = loopFrames - 1;
  const boundary = [Math.abs(sample(last, 0) - sample(0, 0)), Math.abs(sample(last, 1) - sample(0, 1))];
  const reference = [0, 0];
  const widen = (frame) => {
    for (const channel of [0, 1]) {
      const step = Math.abs(sample(frame + 1, channel) - sample(frame, channel));
      reference[channel] = Math.max(reference[channel], step);
    }
  };
  for (let frame = loopFrames - SEAM_FRAMES; frame < last; frame += 1) {
    widen(frame);
  }
  for (let frame = 0; frame < SEAM_FRAMES - 1; frame += 1) {
    widen(frame);
  }
  return { boundary, reference, frames };
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

mkdirSync(workMusic, { recursive: true });
mkdirSync(contentMusic, { recursive: true });

const shippedTracks = [];
for (const track of TRACKS) {
  const sourceWav = resolve(srcDir, track.file);
  const trimWav = resolve(workMusic, `${track.id}-trim.wav`);
  const loopWav = resolve(workMusic, `${track.id}-loop.wav`);
  const normWav = resolve(workMusic, `${track.id}-norm.wav`);
  const oggFile = resolve(workMusic, `${track.id}.ogg`);
  const m4aFile = resolve(workMusic, `${track.id}.m4a`);

  probeDuration(sourceWav);
  trimSilence(sourceWav, trimWav);
  const trimmedFrames = probeFrames(trimWav);
  // Down to the millisecond grid, then the crossfade's overlap off: both terms are whole
  // milliseconds, so the loop is one too and duration = loopFrames / SAMPLE_RATE is exact at the
  // three decimals JSON carries.
  const cutFrames = Math.floor(trimmedFrames / MS_FRAMES) * MS_FRAMES;
  const loopFrames = cutFrames - CROSSFADE_FRAMES;
  if (cutFrames <= HEAD_FRAMES + CROSSFADE_FRAMES) {
    fail(`loop ${track.id}: ${cutFrames} frames leaves no tail to crossfade into the head`, null);
  }
  buildLoop(trimWav, cutFrames, loopWav);
  const loudness = normalize(loopWav, normWav);
  const duration = loopFrames / SAMPLE_RATE;
  encode(normWav, oggFile, m4aFile);
  const seam = seamCheck(normWav, loopFrames);
  // The graph's arithmetic said loopFrames; the file has to agree, or the boundary the check just
  // certified is not the file's boundary either.
  if (seam.frames !== loopFrames) {
    fail(`loop ${track.id}: the file holds ${seam.frames} frames, the arithmetic says ${loopFrames}`, null);
  }
  const boundaryStep = round(Math.max(...seam.boundary), 4);
  const reference = round(Math.max(...seam.reference), 4);
  for (const channel of [0, 1]) {
    if (seam.boundary[channel] > SEAM_RATIO * seam.reference[channel]) {
      fail(
        `seam check ${track.id} channel ${channel}: boundary step ` +
          `${seam.boundary[channel].toFixed(4)} exceeds ${SEAM_RATIO}x reference ` +
          `${seam.reference[channel].toFixed(4)}`,
        null,
      );
    }
  }

  const oggBytes = statSync(oggFile).size;
  const m4aBytes = statSync(m4aFile).size;
  console.log(
    `${track.id}  loop ${duration.toFixed(3)} s (${loopFrames} frames)  loudness ` +
      `${loudness.inputLu.toFixed(1)} -> ${loudness.outputLu.toFixed(1)} LUFS  seam ` +
      `${boundaryStep.toFixed(4)} <= ${SEAM_RATIO}x ${reference.toFixed(4)}  opus ${oggBytes} B  ` +
      `aac ${m4aBytes} B`,
  );

  if (SHIPPED.includes(track.id)) {
    copyFileSync(oggFile, resolve(contentMusic, `${track.id}.ogg`));
    copyFileSync(m4aFile, resolve(contentMusic, `${track.id}.m4a`));
    shippedTracks.push({
      id: track.id,
      title: track.title,
      source: track.file,
      duration: round(duration, 3),
      loudness: { input: round(loudness.inputLu, 1), output: round(loudness.outputLu, 1) },
      seam: { boundaryStep, reference },
      sources: [
        { url: `${track.id}.ogg`, type: 'audio/ogg; codecs="opus"', bytes: oggBytes },
        { url: `${track.id}.m4a`, type: 'audio/mp4; codecs="mp4a.40.2"', bytes: m4aBytes },
      ],
    });
  }
}

const manifest = {
  version: 1,
  default: SHIPPED[0],
  tracks: shippedTracks,
};
writeFileSync(resolve(contentMusic, 'music.json'), shippedJson(manifest), 'utf8');
console.log(`music: wrote ${shippedTracks.length} track(s) to ${resolve(contentMusic, 'music.json')}`);
