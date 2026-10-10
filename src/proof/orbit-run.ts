// Scripted 10-second inspection orbit around the showroom proof target.

export interface OrbitFrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

export interface OrbitRunOptions {
  /**
   * Applies one pose of the orbit. The position argument is a tuple the run owns and rewrites
   * on every tick: consume it synchronously and never retain it past the call.
   */
  setPose(position: [number, number, number], target: [number, number, number]): void;
  proofPosition: [number, number, number];
  proofTarget: [number, number, number];
  durationMs: number; // 10000
  onFrame: () => void; // asks the loop for a frame
  now: () => number;
  signal?: AbortSignal;
  scheduler?: OrbitFrameScheduler;
}

// Approximate a display tick only where requestAnimationFrame is unavailable.
const FALLBACK_FRAME_MS = 16;

/**
 * The fallback proof pose, and nothing else. The catalogue owns the real one (catalog.views.proof,
 * the same pose the camera mounts with), and the composition root hands it to runProofOrbit;
 * these two constants are only what the Measure run falls back to before the camera has mounted,
 * which is also the one case where it refuses to run. They are kept in step with the catalogue by
 * tests/unit/proof-orbit-run.test.ts, so a changed view is a red test rather than a wrong orbit.
 */
export const PROOF_POSITION: [number, number, number] = [0, 1.7, 4.2];
export const PROOF_TARGET: [number, number, number] = [0, 1.0, 0];

/**
 * Drives setPose in one full turn around proofTarget at the proof radius and height over durationMs.
 * Resolves when the circle has closed; abort rejects with AbortError without restoring the pose.
 */
export function runProofOrbit(options: OrbitRunOptions): Promise<void> {
  const { setPose, proofPosition, proofTarget, durationMs, onFrame, now } = options;

  return new Promise<void>((resolve, reject) => {
    const signal = options.signal;
    const scheduler = options.scheduler ?? (typeof requestAnimationFrame === 'function' ? {
      request: (callback: () => void) => requestAnimationFrame(callback),
      cancel: (handle: number) => cancelAnimationFrame(handle),
    } : null);
    let pendingFrame: number | null = null;
    let pendingTimeout: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    function cleanup(): void {
      settled = true;
      if (pendingFrame !== null) {
        scheduler?.cancel(pendingFrame);
        pendingFrame = null;
      }
      if (pendingTimeout !== null) {
        clearTimeout(pendingTimeout);
        pendingTimeout = null;
      }
      signal?.removeEventListener('abort', abort);
    }

    function abort(): void {
      if (settled) return;
      cleanup();
      reject(new DOMException('Proof orbit aborted', 'AbortError'));
    }

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });

    const dx0 = proofPosition[0] - proofTarget[0];
    const dz0 = proofPosition[2] - proofTarget[2];
    const radius = Math.hypot(dx0, dz0);
    const initialTheta = Math.atan2(dx0, dz0);

    // The position handed to setPose: written in place each tick, so a tick allocates no array.
    // Starts at the opening pose; only x and z change while the orbit runs.
    const currentPosition: [number, number, number] = [
      proofPosition[0],
      proofPosition[1],
      proofPosition[2],
    ];

    function schedule(): void {
      if (settled) return;
      if (scheduler !== null) pendingFrame = scheduler.request(step);
      else pendingTimeout = setTimeout(step, FALLBACK_FRAME_MS);
    }

    function frame(): void {
      if (settled) return;
      setPose(currentPosition, proofTarget);
      if (!settled) onFrame();
    }

    function complete(): void {
      if (settled) return;
      cleanup();
      resolve();
    }

    if (durationMs <= 0) {
      frame();
      complete();
      return;
    }

    const start = now();

    function step(): void {
      if (settled) return;
      pendingFrame = null;
      pendingTimeout = null;
      const elapsed = now() - start;
      if (elapsed >= durationMs) {
        // Close the circle with the exact original pose.
        currentPosition[0] = proofPosition[0];
        currentPosition[1] = proofPosition[1];
        currentPosition[2] = proofPosition[2];
        frame();
        complete();
        return;
      }

      const progress = elapsed / durationMs;
      const theta = initialTheta + 2 * Math.PI * progress;
      currentPosition[0] = proofTarget[0] + radius * Math.sin(theta);
      currentPosition[2] = proofTarget[2] + radius * Math.cos(theta);

      frame();
      schedule();
    }

    // First frame starts at the initial pose.
    frame();
    schedule();
  });
}
