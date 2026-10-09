// Scripted 10-second inspection orbit around the showroom proof target.

export interface OrbitRunOptions {
  setPose(position: [number, number, number], target: [number, number, number]): void;
  proofPosition: [number, number, number];
  proofTarget: [number, number, number];
  durationMs: number; // 10000
  onFrame: () => void; // asks the loop for a frame
  now: () => number;
  raf?: ((cb: () => void) => void) | undefined;
}

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
 * Returns a Promise that resolves when the circle has closed.
 */
export function runProofOrbit(options: OrbitRunOptions): Promise<void> {
  const { setPose, proofPosition, proofTarget, durationMs, onFrame, now } = options;

  return new Promise<void>((resolve) => {
    const dx0 = proofPosition[0] - proofTarget[0];
    const dz0 = proofPosition[2] - proofTarget[2];
    const radius = Math.hypot(dx0, dz0);
    const initialTheta = Math.atan2(dx0, dz0);
    const height = proofPosition[1];

    const raf =
      options.raf ??
      ((cb: () => void): void => {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(cb);
        } else {
          setTimeout(cb, 16);
        }
      });

    if (durationMs <= 0) {
      setPose(proofPosition, proofTarget);
      onFrame();
      resolve();
      return;
    }

    const start = now();

    function step(): void {
      const elapsed = now() - start;
      if (elapsed >= durationMs) {
        // Close the circle with the exact original pose.
        setPose(proofPosition, proofTarget);
        onFrame();
        resolve();
        return;
      }

      const progress = elapsed / durationMs;
      const theta = initialTheta + 2 * Math.PI * progress;
      const x = proofTarget[0] + radius * Math.sin(theta);
      const z = proofTarget[2] + radius * Math.cos(theta);

      setPose([x, height, z], proofTarget);
      onFrame();
      raf(step);
    }

    // First frame starts at the initial pose.
    setPose(proofPosition, proofTarget);
    onFrame();
    raf(step);
  });
}
