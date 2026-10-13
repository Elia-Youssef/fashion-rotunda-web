import { describe, expect, it } from 'vitest';
import { ResizeHandshake } from '../e2e/support/resize-handshake';
import type { ResizeSnapshot } from '../e2e/support/resize-handshake';
import { APPLIED_RESIZE, BEFORE_RESIZE, RESIZE_VIEWPORT, STALE_BUFFER } from '../e2e/support/resize-snapshots';

function handshake(): ResizeHandshake {
  return new ResizeHandshake(BEFORE_RESIZE, RESIZE_VIEWPORT);
}

describe('resize handshake', () => {
  it('rejects a stale buffer after the CSS box changes, despite a newer pre-resize frame', () => {
    const poll = handshake().poll(STALE_BUFFER);
    expect(poll.checks.viewport).toBe(true);
    expect(poll.checks.cssDimensions).toBe(true);
    expect(poll.checks.bufferDimensions).toBe(false);
    expect(poll.checks.appliedResolution).toBe(false);
    expect(poll.sizeReady).toBe(false);
    expect(poll.acknowledgedFrames).toBeNull();
    expect(poll.ready).toBe(false);
  });

  it('requires a frame strictly newer than the size acknowledgement', () => {
    const state = handshake();
    state.poll(STALE_BUFFER);
    const applied = state.poll({ ...APPLIED_RESIZE, frames: 20 });
    expect(applied.sizeReady).toBe(true);
    expect(applied.acknowledgedNow).toBe(true);
    expect(applied.ready).toBe(false);
    expect(state.poll({ ...APPLIED_RESIZE, frames: 20 }).ready).toBe(false);
    const drawn = state.poll({ ...APPLIED_RESIZE, frames: 21 });
    expect(drawn.acknowledgedNow).toBe(false);
    expect(drawn.ready).toBe(true);
  });

  it('keeps the original frame baseline if an acknowledgement reports an older counter', () => {
    const state = handshake();
    expect(state.poll({ ...APPLIED_RESIZE, frames: 5 }).acknowledgedFrames).toBe(BEFORE_RESIZE.frames);
    expect(state.poll({ ...APPLIED_RESIZE, frames: BEFORE_RESIZE.frames }).ready).toBe(false);
    expect(state.poll({ ...APPLIED_RESIZE, frames: BEFORE_RESIZE.frames + 1 }).ready).toBe(true);
  });

  it('rechecks the dimensions after acknowledgement while waiting for the frame', () => {
    const state = handshake();
    state.poll(APPLIED_RESIZE);
    expect(state.poll({ ...STALE_BUFFER, frames: 12 }).ready).toBe(false);
    expect(state.poll({ ...APPLIED_RESIZE, frames: 13 }).ready).toBe(true);
  });

  it.each(['viewportWidth', 'viewportHeight'] as const)('requires the requested %s', (axis) => {
    const poll = handshake().poll({ ...APPLIED_RESIZE, [axis]: BEFORE_RESIZE[axis] });
    expect(poll.checks.viewport).toBe(false);
    expect(poll.sizeReady).toBe(false);
  });

  it.each(['boxWidth', 'boxHeight'] as const)('requires a positive, changed CSS %s', (axis) => {
    for (const value of [0, BEFORE_RESIZE[axis]]) {
      const poll = handshake().poll({ ...APPLIED_RESIZE, [axis]: value });
      expect(poll.checks.cssDimensions).toBe(false);
      expect(poll.sizeReady).toBe(false);
    }
  });

  it.each(['width', 'height'] as const)('requires a positive, changed buffer %s', (axis) => {
    for (const value of [0, BEFORE_RESIZE[axis]]) {
      const poll = handshake().poll({ ...APPLIED_RESIZE, [axis]: value });
      expect(poll.checks.bufferDimensions).toBe(false);
      expect(poll.sizeReady).toBe(false);
    }
  });

  it('rejects changed dimensions with the right aspect but the wrong applied resolution', () => {
    const poll = handshake().poll({ ...APPLIED_RESIZE, width: 500, height: 350 });
    expect(poll.checks.bufferDimensions).toBe(true);
    expect(poll.checks.aspect).toBe(true);
    expect(poll.checks.appliedResolution).toBe(false);
    expect(poll.sizeReady).toBe(false);
  });

  it('reads the applied ratio even when it differs from the scaler step', () => {
    const poll = handshake().poll({
      ...APPLIED_RESIZE,
      scaler: { ...APPLIED_RESIZE.scaler!, step: 1, scale: 0.85 },
    });
    expect(poll.checks.appliedResolution).toBe(true);
    expect(poll.sizeReady).toBe(true);
  });

  it('allows fractional applied ratios with less than one pixel of flooring per axis', () => {
    const poll = handshake().poll({
      ...APPLIED_RESIZE,
      boxWidth: 1001,
      boxHeight: 701,
      width: 1063,
      height: 744,
      scaler: { ...APPLIED_RESIZE.scaler!, appliedPixelRatio: 1.0625 },
    });
    expect(poll.checks.appliedResolution).toBe(true);
    expect(poll.checks.aspect).toBe(true);
    expect(poll.sizeReady).toBe(true);
  });

  it.each(['width', 'height'] as const)('rejects a full pixel of error and oversizing on %s', (axis) => {
    for (const delta of [-1, 1]) {
      const poll = handshake().poll({ ...APPLIED_RESIZE, [axis]: APPLIED_RESIZE[axis] + delta });
      expect(poll.checks.appliedResolution).toBe(false);
      expect(poll.sizeReady).toBe(false);
    }
  });

  it('retains the aspect check for buffers whose possible ratio intervals do not overlap', () => {
    const poll = handshake().poll({ ...APPLIED_RESIZE, width: 850, height: 700 });
    expect(poll.checks.aspect).toBe(false);
    expect(poll.sizeReady).toBe(false);
  });

  it.each([null, 0, NaN, Infinity])('rejects a missing or invalid applied ratio (%s)', (ratio) => {
    const snapshot: ResizeSnapshot = {
      ...APPLIED_RESIZE,
      scaler: ratio === null ? null : { ...APPLIED_RESIZE.scaler!, appliedPixelRatio: ratio },
    };
    expect(handshake().poll(snapshot).sizeReady).toBe(false);
  });

  it('never acknowledges an unknown frame counter or accepts a non-finite newer counter', () => {
    const state = handshake();
    expect(state.poll({ ...APPLIED_RESIZE, frames: NaN }).acknowledgedFrames).toBeNull();
    expect(state.poll(APPLIED_RESIZE).ready).toBe(false);
    expect(state.poll({ ...APPLIED_RESIZE, frames: Infinity }).ready).toBe(false);
  });

  it('attaches every size and frame poll, the baseline and failed conditions to the failure message', () => {
    const state = handshake();
    state.poll(STALE_BUFFER);
    state.poll(APPLIED_RESIZE);
    state.poll({ ...APPLIED_RESIZE, frames: 12 });
    const message = state.failureMessage('Timeout 15000ms');
    expect(message).toContain('Timeout 15000ms');
    const details = JSON.parse(message.split('Resize polls:\n')[1]) as {
      requestedViewport: typeof RESIZE_VIEWPORT;
      before: ResizeSnapshot;
      polls: { snapshot: ResizeSnapshot; checks: { appliedResolution: boolean; newerFrame: boolean } }[];
    };
    expect(details.requestedViewport).toEqual(RESIZE_VIEWPORT);
    expect(details.before).toEqual(BEFORE_RESIZE);
    expect(details.polls.map((poll) => poll.snapshot)).toEqual([
      STALE_BUFFER, APPLIED_RESIZE, { ...APPLIED_RESIZE, frames: 12 },
    ]);
    expect(details.polls.map((poll) => poll.checks.appliedResolution)).toEqual([false, true, true]);
    expect(details.polls.map((poll) => poll.checks.newerFrame)).toEqual([false, false, true]);
  });
});
