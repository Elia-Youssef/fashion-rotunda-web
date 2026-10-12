// Unit tests for camera pose blending.
// Verifies exact boundary values at t=0 and t=1, monotonicity, ease in-out behavior, and the
// into-destination form the frame paths use: bit-exact against recorded values, reusable
// destinations, and safe writes when the destination is one of the endpoints.

import { describe, expect, it } from 'vitest';

import { BLEND_MS, blendPoseInto } from '../../src/camera/blend';
import type { Pose } from '../../src/camera/blend';
import golden from '../fixtures/camera-pose-golden.json';

const POSE_A: Pose = {
  position: [0, 1.7, 4.2],
  target: [0, 1, 0],
};

const POSE_B: Pose = {
  position: [0, 1.65, 5.5],
  target: [0, 1.65, 4.5],
};

/** The fixture stores plain arrays; the blend functions take fixed-length tuples. */
function asPose(raw: { position: number[]; target: number[] }): Pose {
  return {
    position: [raw.position[0], raw.position[1], raw.position[2]],
    target: [raw.target[0], raw.target[1], raw.target[2]],
  };
}

describe('blendPoseInto boundaries and easing', () => {
  it('defines BLEND_MS as 700', () => {
    expect(BLEND_MS).toBe(700);
  });

  it('returns from exactly when t <= 0', () => {
    const poseZero = blendPoseInto(POSE_A, POSE_B, 0, { position: [0, 0, 0], target: [0, 0, 0] });
    expect(poseZero.position).toEqual(POSE_A.position);
    expect(poseZero.target).toEqual(POSE_A.target);

    const poseNegative = blendPoseInto(POSE_A, POSE_B, -0.5, { position: [0, 0, 0], target: [0, 0, 0] });
    expect(poseNegative.position).toEqual(POSE_A.position);
    expect(poseNegative.target).toEqual(POSE_A.target);
  });

  it('returns to exactly when t >= 1', () => {
    const poseOne = blendPoseInto(POSE_A, POSE_B, 1, { position: [0, 0, 0], target: [0, 0, 0] });
    expect(poseOne.position).toEqual(POSE_B.position);
    expect(poseOne.target).toEqual(POSE_B.target);

    const posePast = blendPoseInto(POSE_A, POSE_B, 1.5, { position: [0, 0, 0], target: [0, 0, 0] });
    expect(posePast.position).toEqual(POSE_B.position);
    expect(posePast.target).toEqual(POSE_B.target);
  });

  it('is monotonic from 0 to 1', () => {
    let previousProgress = 0;
    const samples = 100;
    for (let i = 1; i <= samples; i += 1) {
      const t = i / samples;
      const pose = blendPoseInto(POSE_A, POSE_B, t, { position: [0, 0, 0], target: [0, 0, 0] });
      // Progress along z axis from 4.2 to 5.5.
      const progress = (pose.position[2] - 4.2) / (5.5 - 4.2);
      expect(progress).toBeGreaterThanOrEqual(previousProgress);
      previousProgress = progress;
    }
  });

  it('eases in and out (acceleration at start, deceleration at end)', () => {
    // In cubic ease-in-out, factor at t=0.1 is 4*(0.1^3) = 0.004 (< 0.1, slow start).
    const poseEarly = blendPoseInto(POSE_A, POSE_B, 0.1, { position: [0, 0, 0], target: [0, 0, 0] });
    const progressEarly = (poseEarly.position[2] - 4.2) / (5.5 - 4.2);
    expect(progressEarly).toBeLessThan(0.05);

    // At t=0.5, factor is exactly 0.5.
    const poseMid = blendPoseInto(POSE_A, POSE_B, 0.5, { position: [0, 0, 0], target: [0, 0, 0] });
    const progressMid = (poseMid.position[2] - 4.2) / (5.5 - 4.2);
    expect(progressMid).toBeCloseTo(0.5, 5);

    // At t=0.9, factor is 1 - 4*(0.1^3) = 0.996 (> 0.9, slow landing).
    const poseLate = blendPoseInto(POSE_A, POSE_B, 0.9, { position: [0, 0, 0], target: [0, 0, 0] });
    const progressLate = (poseLate.position[2] - 4.2) / (5.5 - 4.2);
    expect(progressLate).toBeGreaterThan(0.95);
  });
});

describe('blendPoseInto', () => {
  it('replays the recorded blends bit-exactly', () => {
    // The fixture holds the results of the allocating implementation, recorded before the
    // into-destination form existed. Every number must round-trip exactly.
    const destination: Pose = { position: [0, 0, 0], target: [0, 0, 0] };
    for (const row of golden.blend) {
      const out = blendPoseInto(asPose(row.from), asPose(row.to), row.t, destination);
      expect(out.position).toEqual(row.pose.position);
      expect(out.target).toEqual(row.pose.target);
    }
  });

  it('returns the destination it was given and rewrites it on every call', () => {
    const destination: Pose = { position: [0, 0, 0], target: [0, 0, 0] };
    const first = blendPoseInto(POSE_A, POSE_B, 0.25, destination);
    expect(first).toBe(destination);
    const second = blendPoseInto(POSE_A, POSE_B, 0.75, destination);
    expect(second).toBe(destination);
    expect(second.position).toEqual(
      blendPoseInto(POSE_A, POSE_B, 0.75, { position: [0, 0, 0], target: [0, 0, 0] }).position,
    );
    expect(second.target).toEqual(
      blendPoseInto(POSE_A, POSE_B, 0.75, { position: [0, 0, 0], target: [0, 0, 0] }).target,
    );
  });

  it('writes distinct destinations independently', () => {
    const firstDestination: Pose = { position: [0, 0, 0], target: [0, 0, 0] };
    const secondDestination: Pose = { position: [0, 0, 0], target: [0, 0, 0] };
    const first = blendPoseInto(POSE_A, POSE_B, 0.25, firstDestination);
    const second = blendPoseInto(POSE_A, POSE_B, 0.75, secondDestination);
    expect(first).not.toBe(second);
    expect(first.position).toEqual(
      blendPoseInto(POSE_A, POSE_B, 0.25, { position: [0, 0, 0], target: [0, 0, 0] }).position,
    );
    expect(first.target).toEqual(
      blendPoseInto(POSE_A, POSE_B, 0.25, { position: [0, 0, 0], target: [0, 0, 0] }).target,
    );
    expect(second.position).toEqual(
      blendPoseInto(POSE_A, POSE_B, 0.75, { position: [0, 0, 0], target: [0, 0, 0] }).position,
    );
    expect(second.target).toEqual(
      blendPoseInto(POSE_A, POSE_B, 0.75, { position: [0, 0, 0], target: [0, 0, 0] }).target,
    );
  });

  it('writes safely when the destination is the from pose', () => {
    const from: Pose = { position: [...POSE_A.position], target: [...POSE_A.target] };
    const expected = blendPoseInto(from, POSE_B, 0.3, { position: [0, 0, 0], target: [0, 0, 0] });
    const out = blendPoseInto(from, POSE_B, 0.3, from);
    expect(out).toBe(from);
    expect(out.position).toEqual(expected.position);
    expect(out.target).toEqual(expected.target);
  });

  it('writes safely when the destination is the to pose', () => {
    const to: Pose = { position: [...POSE_B.position], target: [...POSE_B.target] };
    const expected = blendPoseInto(POSE_A, to, 0.7, { position: [0, 0, 0], target: [0, 0, 0] });
    const out = blendPoseInto(POSE_A, to, 0.7, to);
    expect(out).toBe(to);
    expect(out.position).toEqual(expected.position);
    expect(out.target).toEqual(expected.target);
  });

  it('copies the endpoints exactly, including into an aliased destination', () => {
    const from: Pose = { position: [...POSE_A.position], target: [...POSE_A.target] };
    const to: Pose = { position: [...POSE_B.position], target: [...POSE_B.target] };
    const fromBefore = JSON.stringify(from);
    const toBefore = JSON.stringify(to);

    const atZero = blendPoseInto(from, to, 0, from);
    expect(atZero.position).toEqual(POSE_A.position);
    expect(atZero.target).toEqual(POSE_A.target);
    const atOne = blendPoseInto(from, to, 1, to);
    expect(atOne.position).toEqual(POSE_B.position);
    expect(atOne.target).toEqual(POSE_B.target);
    const pastOne = blendPoseInto(from, to, 2.5, to);
    expect(pastOne.position).toEqual(POSE_B.position);
    const pastZero = blendPoseInto(from, to, -1, from);
    expect(pastZero.position).toEqual(POSE_A.position);

    expect(JSON.stringify(from)).toBe(fromBefore);
    expect(JSON.stringify(to)).toBe(toBefore);
  });

  it('never mutates its sources at any blend factor', () => {
    const from: Pose = { position: [...POSE_A.position], target: [...POSE_A.target] };
    const to: Pose = { position: [...POSE_B.position], target: [...POSE_B.target] };
    const fromBefore = JSON.stringify(from);
    const toBefore = JSON.stringify(to);
    const destination: Pose = { position: [0, 0, 0], target: [0, 0, 0] };
    for (const t of [0, 0.001, 0.25, 0.5, 0.75, 0.999, 1]) {
      blendPoseInto(from, to, t, destination);
      expect(JSON.stringify(from)).toBe(fromBefore);
      expect(JSON.stringify(to)).toBe(toBefore);
    }
  });
});
