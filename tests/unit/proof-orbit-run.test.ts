import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROOF_POSITION, PROOF_TARGET, runProofOrbit } from '../../src/proof/orbit-run';

/** Narrows the parsed catalogue down to views.proof through `in` checks, with no cast anywhere. */
function readProofView(json: string): unknown {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== 'object' || raw === null || !('views' in raw)) {
    return null;
  }
  const views: unknown = raw.views;
  if (typeof views !== 'object' || views === null || !('proof' in views)) {
    return null;
  }
  return views.proof;
}

describe('the fallback proof pose', () => {
  it('matches catalog.views.proof, the pose the camera actually mounts with', () => {
    const proof = readProofView(readFileSync('public/content/catalog.json', 'utf8'));
    expect(proof).toMatchObject({ position: PROOF_POSITION, target: PROOF_TARGET });
  });
});

describe('runProofOrbit', () => {
  it('closes the circle and resolves the promise on a fake clock', async () => {
    const proofPosition: [number, number, number] = [0, 1.7, 4.2];
    const proofTarget: [number, number, number] = [0, 1.0, 0];
    const expectedRadius = Math.hypot(proofPosition[0] - proofTarget[0], proofPosition[2] - proofTarget[2]);

    const poses: [number, number, number][] = [];
    const targets: [number, number, number][] = [];
    let frameCalls = 0;

    let currentTime = 0;
    const callbacks: (() => void)[] = [];

    const raf = (cb: () => void): void => {
      callbacks.push(cb);
    };

    const promise = runProofOrbit({
      setPose: (pos, tgt) => {
        poses.push(pos);
        targets.push(tgt);
      },
      proofPosition,
      proofTarget,
      durationMs: 10_000,
      onFrame: () => {
        frameCalls += 1;
      },
      now: () => currentTime,
      raf,
    });

    // First frame is synchronously recorded before the first tick.
    expect(poses.length).toBe(1);
    expect(poses[0]).toEqual(proofPosition);
    expect(targets[0]).toEqual(proofTarget);
    expect(frameCalls).toBe(1);

    // Step through in increments of 1000 ms.
    for (let step = 1; step <= 10; step += 1) {
      currentTime = step * 1000;
      const nextCb = callbacks.shift();
      expect(nextCb).toBeDefined();
      nextCb?.();
    }

    await promise;

    // We recorded 1 initial pose + 9 intermediate ticks + 1 terminal pose = 11 poses.
    expect(poses.length).toBe(11);
    expect(frameCalls).toBe(11);

    // Every pose keeps the proof height and proof radius from target.
    for (const pos of poses) {
      expect(pos[1]).toBeCloseTo(1.7, 5);
      const r = Math.hypot(pos[0] - proofTarget[0], pos[2] - proofTarget[2]);
      expect(r).toBeCloseTo(expectedRadius, 5);
    }

    // Final pose closes the circle at the exact start pose.
    const lastPose = poses[poses.length - 1];
    expect(lastPose).toEqual(proofPosition);
  });

  it('resolves immediately when durationMs is zero or negative', async () => {
    const proofPosition: [number, number, number] = [1, 2, 3];
    const proofTarget: [number, number, number] = [0, 0, 0];
    const poses: [number, number, number][] = [];

    await runProofOrbit({
      setPose: (pos) => poses.push(pos),
      proofPosition,
      proofTarget,
      durationMs: 0,
      onFrame: () => {},
      now: () => 0,
    });

    expect(poses).toEqual([proofPosition]);
  });
});
