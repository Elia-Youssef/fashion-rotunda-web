import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROOF_POSITION, PROOF_TARGET, runProofOrbit } from '../../src/proof/orbit-run';
import golden from '../fixtures/camera-pose-golden.json';

/** The run reuses one position tuple across ticks; a recorded pose is a copy taken at the tick. */
function recordPose(position: [number, number, number]): [number, number, number] {
  return [position[0], position[1], position[2]];
}

/** The abort contract: the promise rejects with a DOMException named AbortError. */
async function expectAbort(promise: Promise<void>): Promise<void> {
  const failure = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(DOMException);
  expect((failure as DOMException).name).toBe('AbortError');
}

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
        poses.push(recordPose(pos));
        targets.push(recordPose(tgt));
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
      setPose: (pos) => poses.push(recordPose(pos)),
      proofPosition,
      proofTarget,
      durationMs: 0,
      onFrame: () => {},
      now: () => 0,
    });

    expect(poses).toEqual([proofPosition]);
  });

  it('reuses one position tuple across every setPose call', async () => {
    const proofPosition: [number, number, number] = [0, 1.7, 4.2];
    const proofTarget: [number, number, number] = [0, 1, 0];
    const identities: unknown[] = [];
    let clock = 0;
    const callbacks: (() => void)[] = [];

    const promise = runProofOrbit({
      setPose: (pos) => {
        identities.push(pos);
      },
      proofPosition,
      proofTarget,
      durationMs: 10_000,
      onFrame: () => {},
      now: () => clock,
      scheduler: {
        request: (callback) => {
          callbacks.push(callback);
          return callbacks.length;
        },
        cancel: () => {},
      },
    });

    for (let step = 1; step <= 10; step += 1) {
      clock = step * 1000;
      callbacks.shift()?.();
    }
    await promise;

    expect(identities).toHaveLength(11);
    for (const entry of identities) {
      expect(entry).toBe(identities[0]);
    }
  });

  it('replays the recorded ten-second pose sequence exactly', async () => {
    const recorded = golden.proofOrbit;
    const calls: { position: [number, number, number]; target: [number, number, number] }[] = [];
    let frameCalls = 0;
    let clock = 0;
    const callbacks: (() => void)[] = [];

    const promise = runProofOrbit({
      setPose: (position, target) => {
        calls.push({ position: recordPose(position), target: recordPose(target) });
      },
      proofPosition: [recorded.proofPosition[0], recorded.proofPosition[1], recorded.proofPosition[2]],
      proofTarget: [recorded.proofTarget[0], recorded.proofTarget[1], recorded.proofTarget[2]],
      durationMs: recorded.durationMs,
      onFrame: () => {
        frameCalls += 1;
      },
      now: () => clock,
      scheduler: {
        request: (callback) => {
          callbacks.push(callback);
          return callbacks.length;
        },
        cancel: () => {},
      },
    });

    for (const moment of recorded.steps) {
      clock = moment;
      const callback = callbacks.shift();
      expect(callback).toBeDefined();
      callback?.();
    }
    await promise;

    expect(frameCalls).toBe(recorded.frameCalls);
    expect(calls).toEqual(recorded.setPoseCalls);
  });

  it('schedules no further work when setPose aborts during the opening frame', async () => {
    const controller = new AbortController();
    const request = vi.fn(() => 1);
    const cancel = vi.fn();
    const setPose = vi.fn(() => {
      controller.abort();
    });
    const onFrame = vi.fn();
    const finished = runProofOrbit({
      setPose,
      onFrame,
      proofPosition: PROOF_POSITION,
      proofTarget: PROOF_TARGET,
      durationMs: 100,
      now: () => 0,
      signal: controller.signal,
      scheduler: { request, cancel },
    });
    await expectAbort(finished);
    expect(setPose).toHaveBeenCalledTimes(1);
    expect(onFrame).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('stays inert when now aborts before the opening frame', async () => {
    const controller = new AbortController();
    const request = vi.fn(() => 1);
    const setPose = vi.fn();
    const onFrame = vi.fn();
    const finished = runProofOrbit({
      setPose,
      onFrame,
      proofPosition: PROOF_POSITION,
      proofTarget: PROOF_TARGET,
      durationMs: 100,
      now: () => {
        controller.abort();
        return 0;
      },
      signal: controller.signal,
      scheduler: { request, cancel: () => {} },
    });
    await expectAbort(finished);
    expect(setPose).not.toHaveBeenCalled();
    expect(onFrame).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('does not ask the loop for the frame whose setPose aborted', async () => {
    const controller = new AbortController();
    const callbacks: (() => void)[] = [];
    let calls = 0;
    const setPose = vi.fn(() => {
      calls += 1;
      if (calls === 2) controller.abort();
    });
    const onFrame = vi.fn();
    let clock = 0;
    const finished = runProofOrbit({
      setPose,
      onFrame,
      proofPosition: PROOF_POSITION,
      proofTarget: PROOF_TARGET,
      durationMs: 10_000,
      now: () => clock,
      signal: controller.signal,
      scheduler: {
        request: (callback) => {
          callbacks.push(callback);
          return callbacks.length;
        },
        cancel: () => {},
      },
    });
    expect(setPose).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledTimes(1);
    clock = 5_000;
    callbacks.shift()?.();
    await expectAbort(finished);
    expect(setPose).toHaveBeenCalledTimes(2);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(callbacks).toHaveLength(0);
  });
});
