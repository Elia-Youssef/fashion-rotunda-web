// Unit tests for camera pose blending.
// Verifies exact boundary values at t=0 and t=1, monotonicity, and ease in-out behavior.

import { describe, expect, it } from 'vitest';

import { BLEND_MS, blendPose } from '../../src/camera/blend';
import type { Pose } from '../../src/camera/blend';

const POSE_A: Pose = {
  position: [0, 1.7, 4.2],
  target: [0, 1, 0],
};

const POSE_B: Pose = {
  position: [0, 1.65, 5.5],
  target: [0, 1.65, 4.5],
};

describe('blendPose', () => {
  it('defines BLEND_MS as 700', () => {
    expect(BLEND_MS).toBe(700);
  });

  it('returns from exactly when t <= 0', () => {
    const poseZero = blendPose(POSE_A, POSE_B, 0);
    expect(poseZero.position).toEqual(POSE_A.position);
    expect(poseZero.target).toEqual(POSE_A.target);

    const poseNegative = blendPose(POSE_A, POSE_B, -0.5);
    expect(poseNegative.position).toEqual(POSE_A.position);
    expect(poseNegative.target).toEqual(POSE_A.target);
  });

  it('returns to exactly when t >= 1', () => {
    const poseOne = blendPose(POSE_A, POSE_B, 1);
    expect(poseOne.position).toEqual(POSE_B.position);
    expect(poseOne.target).toEqual(POSE_B.target);

    const posePast = blendPose(POSE_A, POSE_B, 1.5);
    expect(posePast.position).toEqual(POSE_B.position);
    expect(posePast.target).toEqual(POSE_B.target);
  });

  it('is monotonic from 0 to 1', () => {
    let previousProgress = 0;
    const samples = 100;
    for (let i = 1; i <= samples; i += 1) {
      const t = i / samples;
      const pose = blendPose(POSE_A, POSE_B, t);
      // Progress along z axis from 4.2 to 5.5.
      const progress = (pose.position[2] - 4.2) / (5.5 - 4.2);
      expect(progress).toBeGreaterThanOrEqual(previousProgress);
      previousProgress = progress;
    }
  });

  it('eases in and out (acceleration at start, deceleration at end)', () => {
    // In cubic ease-in-out, factor at t=0.1 is 4*(0.1^3) = 0.004 (< 0.1, slow start).
    const poseEarly = blendPose(POSE_A, POSE_B, 0.1);
    const progressEarly = (poseEarly.position[2] - 4.2) / (5.5 - 4.2);
    expect(progressEarly).toBeLessThan(0.05);

    // At t=0.5, factor is exactly 0.5.
    const poseMid = blendPose(POSE_A, POSE_B, 0.5);
    const progressMid = (poseMid.position[2] - 4.2) / (5.5 - 4.2);
    expect(progressMid).toBeCloseTo(0.5, 5);

    // At t=0.9, factor is 1 - 4*(0.1^3) = 0.996 (> 0.9, slow landing).
    const poseLate = blendPose(POSE_A, POSE_B, 0.9);
    const progressLate = (poseLate.position[2] - 4.2) / (5.5 - 4.2);
    expect(progressLate).toBeGreaterThan(0.95);
  });
});
