// Goal G4.6: the attract loop.
// Tours the catalogue presets in order after ATTRACT_IDLE_MS (60 s) of user inactivity.
// Each preset is reached via an eased glide over ATTRACT_MOVE_MS (3 s) and held for
// ATTRACT_HOLD_MS (4 s). Any user input stops the tour immediately and restarts the idle clock.
// Reduced motion cuts immediately (moveMs treated as 0). Disabled by default on touch.

import { blendPose } from './blend';
import type { Pose } from './blend';
import type { NamedView } from './presets';

export const ATTRACT_IDLE_MS = 60_000;
export const ATTRACT_HOLD_MS = 4_000;
export const ATTRACT_MOVE_MS = 3_000;

export interface AttractOptions {
  views: readonly NamedView[];
  idleMs: number;
  holdMs: number;
  moveMs: number;
  enabled: boolean; // false by default on touch; ?attract=1|0 overrides
  reducedMotion: boolean; // moveMs treated as 0
  now?: () => number;
}

export interface AttractHandle {
  readonly running: boolean;
  readonly enabled: boolean;
  setEnabled(on: boolean): void;
  noteInput(): void; // any input: stops a running tour, restarts the idle clock
  /** Called every frame while running or waiting; returns the pose to show, or null to leave the camera. */
  tick(): { pose: Pose; viewId: string; fov: number } | null;
}

type TourPhase = 'move' | 'hold';

function easeProgress(elapsedMs: number, durationMs: number): number {
  const t = durationMs > 0 ? Math.min(1, Math.max(0, elapsedMs / durationMs)) : 1;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function createAttract(options: AttractOptions): AttractHandle {
  const { views, idleMs, holdMs, reducedMotion } = options;
  const moveMs = reducedMotion ? 0 : options.moveMs;
  const now = options.now ?? ((): number => performance.now());

  let isEnabled = options.enabled;
  let isRunning = false;
  let lastInputTime = now();

  let phase: TourPhase = 'move';
  let phaseStartTime = 0;
  let sourceIndex = 0;
  let targetIndex = 0;

  function stop(): void {
    isRunning = false;
    lastInputTime = now();
  }

  return {
    get running(): boolean {
      return isRunning;
    },

    get enabled(): boolean {
      return isEnabled;
    },

    setEnabled(on: boolean): void {
      if (isEnabled === on) {
        return;
      }
      isEnabled = on;
      if (!on && isRunning) {
        stop();
      }
    },

    noteInput(): void {
      stop();
    },

    tick(): { pose: Pose; viewId: string; fov: number } | null {
      if (!isEnabled || views.length === 0) {
        return null;
      }

      const currentTime = now();

      if (!isRunning) {
        if (currentTime - lastInputTime >= idleMs) {
          // Idle timeout reached: launch the tour.
          isRunning = true;
          sourceIndex = 0;
          targetIndex = views.length > 1 ? 1 : 0;
          phaseStartTime = currentTime;
          phase = moveMs === 0 ? 'hold' : 'move';
        } else {
          return null;
        }
      }

      const targetView = views[targetIndex];
      const sourceView = views[sourceIndex];

      const fromPose: Pose = {
        position: sourceView.position,
        target: sourceView.target,
      };
      const toPose: Pose = {
        position: targetView.position,
        target: targetView.target,
      };

      if (phase === 'move') {
        const elapsed = currentTime - phaseStartTime;
        if (elapsed >= moveMs) {
          phase = 'hold';
          phaseStartTime = currentTime;
          return { pose: toPose, viewId: targetView.id, fov: targetView.fov };
        }
        const t = moveMs > 0 ? elapsed / moveMs : 1;
        const currentPose = blendPose(fromPose, toPose, t);
        return {
          pose: currentPose,
          viewId: targetView.id,
          fov: sourceView.fov + (targetView.fov - sourceView.fov) * easeProgress(elapsed, moveMs),
        };
      }

      // 'hold' phase
      const elapsed = currentTime - phaseStartTime;
      if (elapsed >= holdMs) {
        // Advance to next preset view.
        sourceIndex = targetIndex;
        targetIndex = (targetIndex + 1) % views.length;
        phaseStartTime = currentTime;
        phase = moveMs === 0 ? 'hold' : 'move';
        const nextView = views[targetIndex];
        const heldView = views[sourceIndex];
        if (moveMs === 0) {
          return {
            pose: { position: nextView.position, target: nextView.target },
            viewId: nextView.id,
            fov: nextView.fov,
          };
        }
        // Start the next glide from the view just held. Returning the destination here flashes it
        // for one frame, then the following frame jumps backwards to the beginning of the glide.
        return {
          pose: { position: heldView.position, target: heldView.target },
          viewId: nextView.id,
          fov: heldView.fov,
        };
      }

      return { pose: toPose, viewId: targetView.id, fov: targetView.fov };
    },
  };
}
