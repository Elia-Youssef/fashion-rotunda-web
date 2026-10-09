import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROOF_POSITION, PROOF_TARGET, runProofOrbit } from '../../src/proof/orbit-run';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(['raf', 'timeout'] as const)('orbit lifetime with %s scheduling', (kind) => {
  it.each(['before', 'during', 'after'] as const)('retires work when aborted %s the run', async (stage) => {
    vi.useFakeTimers();
    const queued = new Map<number, () => void>();
    let nextId = 0;
    const request = vi.fn((callback: () => void) => {
      queued.set(++nextId, callback);
      return nextId;
    });
    const cancel = vi.fn((handle: number) => { queued.delete(handle); });
    vi.stubGlobal('requestAnimationFrame', kind === 'raf' ? request : undefined);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    if (stage === 'before') controller.abort();
    let clock = 0;
    const setPose = vi.fn();
    const onFrame = vi.fn();
    let outcome = 'pending';
    const finished = runProofOrbit({
      setPose, onFrame, proofPosition: PROOF_POSITION, proofTarget: PROOF_TARGET,
      durationMs: 100, now: () => clock, signal: controller.signal,
    }).then(() => { outcome = 'completed'; }, (error: unknown) => {
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe('AbortError');
      outcome = 'aborted';
    });
    const advance = async (time: number) => {
      clock = time;
      if (kind === 'raf') {
        const entry = queued.entries().next().value;
        if (entry !== undefined) {
          queued.delete(entry[0]);
          entry[1]();
        }
      } else {
        await vi.advanceTimersByTimeAsync(16);
      }
    };
    if (stage !== 'before') await advance(stage === 'after' ? 100 : 50);
    const staleCallback = queued.values().next().value;
    controller.abort();
    await Promise.resolve();
    expect(outcome).toBe(stage === 'after' ? 'completed' : 'aborted');
    expect(queued.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    if (stage === 'before') {
      expect(setPose).not.toHaveBeenCalled();
      expect(onFrame).not.toHaveBeenCalled();
    } else {
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    }
    const poses = setPose.mock.calls.length;
    const frames = onFrame.mock.calls.length;
    // Even a callback already dispatched by the scheduler must be inert after retirement.
    staleCallback?.();
    await advance(200);
    expect(setPose).toHaveBeenCalledTimes(poses);
    expect(onFrame).toHaveBeenCalledTimes(frames);
    await finished;
  });
});

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

    const raf = (cb: () => void): number => {
      callbacks.push(cb);
      return callbacks.length;
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
      scheduler: { request: raf, cancel: () => {} },
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
