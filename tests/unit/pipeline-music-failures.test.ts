import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  BOUNDARY_STEP,
  LOOP_FRAMES,
  cleanupScriptedModules,
  jumpedBoundaryPcm,
  loopPcm,
  loopWav,
  normWav,
  resetScenario,
  runMusicPipeline,
  sampleAt,
  scenario,
  sourceWav,
  spawnCalls,
  trimWav,
  type PipelineRun,
} from '../support/pipeline-music';

// Every way the tool chain can disagree with the loop arithmetic must stop the script with exit
// status 1 and name the file it happened on. Each case scripts one broken response into an
// otherwise healthy pipeline and reads the console errors fail() printed.

beforeEach(resetScenario);
afterEach(cleanupScriptedModules);

function expectExitOne(run: PipelineRun) {
  expect(run.exitCodes).toEqual([1]);
  expect(run.thrown).toBeInstanceOf(Error);
}

describe('music pipeline failure paths', () => {
  it('rejects a duration ffprobe cannot parse as a positive number', async () => {
    scenario.probeDuration = '-3.2';
    const run = await runMusicPipeline();
    expectExitOne(run);
    expect(run.errors).toEqual([
      `music: probe ${sourceWav('01')}: duration is not a positive number`,
    ]);
    expect(spawnCalls).toHaveLength(1);
  });

  it('rejects a trim that is not at 48 kHz', async () => {
    scenario.probeFrames = 'time_base=1/44100\nduration_ts=576100';
    const run = await runMusicPipeline();
    expectExitOne(run);
    expect(run.errors).toEqual([`music: frames ${trimWav('01')}: time_base 1/44100 is not 1/48000`]);
    expect(spawnCalls).toHaveLength(3);
  });

  it('rejects a trim with a fractional frame count', async () => {
    scenario.probeFrames = 'time_base=1/48000\nduration_ts=576100.5';
    const run = await runMusicPipeline();
    expectExitOne(run);
    expect(run.errors).toEqual([
      `music: frames ${trimWav('01')}: duration_ts is not a positive whole number of frames`,
    ]);
    expect(spawnCalls).toHaveLength(3);
  });

  it('rejects a source too short to crossfade into its own head', async () => {
    scenario.probeFrames = 'time_base=1/48000\nduration_ts=1000';
    const run = await runMusicPipeline();
    expectExitOne(run);
    expect(run.errors).toEqual([
      'music: loop music-01: 960 frames leaves no tail to crossfade into the head',
    ]);
    expect(spawnCalls).toHaveLength(3);
  });

  it('rejects a loudness report whose JSON block is malformed', async () => {
    scenario.loudnessPass1 = '{ "input_i": -15.3, }';
    const run = await runMusicPipeline();
    expectExitOne(run);
    expect(run.errors).toEqual([
      `music: loudness pass 1 ${loopWav('01')}: no measured JSON block on stderr`,
      '{ "input_i": -15.3, }',
    ]);
    expect(spawnCalls).toHaveLength(5);
  });

  it('rejects a loudness report with no JSON block at all', async () => {
    scenario.loudnessPass1 = 'measured nothing usable';
    const run = await runMusicPipeline();
    expectExitOne(run);
    expect(run.errors).toEqual([
      `music: loudness pass 1 ${loopWav('01')}: no measured JSON block on stderr`,
      'measured nothing usable',
    ]);
    expect(spawnCalls).toHaveLength(5);
  });

  it('rejects a decode shorter than the loop arithmetic', async () => {
    scenario.pcm = loopPcm(100);
    const run = await runMusicPipeline();
    expectExitOne(run);
    expect(run.errors).toEqual([
      `music: seam decode ${normWav('01')}: 100 frames is shorter than the ${LOOP_FRAMES}-frame loop`,
    ]);
    expect(spawnCalls).toHaveLength(9);
  });

  it('rejects a decode that is not whole stereo frames', async () => {
    scenario.pcm = Buffer.concat([loopPcm(), Buffer.alloc(4)]);
    const run = await runMusicPipeline();
    expectExitOne(run);
    expect(run.errors).toEqual([
      `music: seam decode ${normWav('01')}: ${LOOP_FRAMES * 8 + 4} bytes is not whole stereo frames`,
    ]);
    expect(spawnCalls).toHaveLength(9);
  });

  it('rejects a decode whose frame count disagrees with the arithmetic', async () => {
    scenario.pcm = loopPcm(LOOP_FRAMES + 48);
    const run = await runMusicPipeline();
    expectExitOne(run);
    expect(run.errors).toEqual([
      'music: loop music-01: the file holds 384144 frames, the arithmetic says 384096',
    ]);
    expect(spawnCalls).toHaveLength(9);
  });

  it('rejects a loop whose boundary steps over its own reference', async () => {
    scenario.pcm = jumpedBoundaryPcm();
    const run = await runMusicPipeline();
    expectExitOne(run);
    // The jump sits on channel 1 only, so the check has to reject on that channel's numbers. The
    // boundary joins the shifted tail to the unshifted head at frame 0.
    const boundary = Math.abs(sampleAt(LOOP_FRAMES - 1) + 3 - sampleAt(0));
    expect(run.errors).toEqual([
      `music: seam check music-01 channel 1: boundary step ${boundary.toFixed(4)}` +
        ` exceeds 1.5x reference ${BOUNDARY_STEP.toFixed(4)}`,
    ]);
    expect(spawnCalls).toHaveLength(9);
  });

  it('reports a failed tool run with its exit status and stderr', async () => {
    scenario.exitStatus = 1;
    scenario.stderr = 'simulated trim failure';
    const run = await runMusicPipeline();
    expectExitOne(run);
    expect(run.errors).toEqual([
      `music: probe ${sourceWav('01')} (exit 1)`,
      'simulated trim failure',
    ]);
    expect(spawnCalls).toHaveLength(1);
  });

  it('reports a tool it cannot start with the spawn error', async () => {
    scenario.spawnError = new Error('spawn ffmpeg-mock ENOENT');
    const run = await runMusicPipeline();
    expectExitOne(run);
    expect(run.errors).toEqual([`music: probe ${sourceWav('01')}: spawn ffmpeg-mock ENOENT`]);
    expect(spawnCalls).toHaveLength(1);
  });

  it('reports a signal kill as a signal, not a status', async () => {
    scenario.exitStatus = null;
    const run = await runMusicPipeline();
    expectExitOne(run);
    expect(run.errors).toEqual([`music: probe ${sourceWav('01')} (exit signal)`]);
    expect(spawnCalls).toHaveLength(1);
  });
});
