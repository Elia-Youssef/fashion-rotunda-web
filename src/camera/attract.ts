// The attract loop.
// Tours the catalogue presets in order after ATTRACT_IDLE_MS (60 s) of user inactivity.
// Each preset is reached via an eased glide over ATTRACT_MOVE_MS (3 s) and held for
// ATTRACT_HOLD_MS (4 s). Any user input stops the tour immediately and restarts the idle clock.
// Reduced motion prevents the tour and stops it immediately. Disabled by default on touch.

import { blendPoseInto, copyPose } from './blend';
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
  reducedMotion: boolean; // prevents the tour independently of its enabled setting
  now?: () => number;
}

export interface AttractReading {
  pose: Pose;
  viewId: string;
  fov: number;
}

export interface AttractHandle {
  readonly running: boolean;
  readonly enabled: boolean;
  setEnabled(on: boolean): void;
  setReducedMotion(reduced: boolean): void;
  noteInput(): void; // any input: stops a running tour, restarts the idle clock
  /**
   * Called every frame while running or waiting; returns the pose to show, or null to leave the
   * camera. The reading is owned by the handle and rewritten by the next tick, so a caller
   * consumes it before ticking again and copies it if it must outlive the tick.
   */
  tick(): AttractReading | null;
}

type TourPhase = 'move' | 'hold';

function easeProgress(elapsedMs: number, durationMs: number): number {
  const t = durationMs > 0 ? Math.min(1, Math.max(0, elapsedMs / durationMs)) : 1;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function createAttract(options: AttractOptions): AttractHandle {
  const { views, idleMs, holdMs, moveMs } = options;
  const now = options.now ?? ((): number => performance.now());

  let isEnabled = options.enabled;
  let isReducedMotion = options.reducedMotion;
  let isRunning = false;
  let lastInputTime = now();

  let phase: TourPhase = 'move';
  let phaseStartTime = 0;
  let sourceIndex = 0;
  let targetIndex = 0;

  // The tick reading and its pose are owned here and written in place: a tour frame must not
  // allocate a pose, a result object or an array. The tour leg reads the view presets directly
  // as blend endpoints; a NamedView carries exactly the position and target a Pose needs.
  const reading: AttractReading = {
    pose: { position: [0, 0, 0], target: [0, 0, 0] },
    viewId: '',
    fov: 0,
  };

  function report(pose: Pose, viewId: string, fov: number): AttractReading {
    copyPose(pose, reading.pose);
    reading.viewId = viewId;
    reading.fov = fov;
    return reading;
  }

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

    setReducedMotion(reduced: boolean): void {
      if (isReducedMotion === reduced) return;
      isReducedMotion = reduced;
      // A preference change ends the old tour; returning to normal motion starts a fresh idle wait.
      stop();
    },

    noteInput(): void {
      stop();
    },

    tick(): AttractReading | null {
      if (!isEnabled || isReducedMotion || views.length === 0) {
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

      if (phase === 'move') {
        const elapsed = currentTime - phaseStartTime;
        if (elapsed >= moveMs) {
          phase = 'hold';
          phaseStartTime = currentTime;
          return report(targetView, targetView.id, targetView.fov);
        }
        const t = moveMs > 0 ? elapsed / moveMs : 1;
        blendPoseInto(sourceView, targetView, t, reading.pose);
        reading.viewId = targetView.id;
        reading.fov =
          sourceView.fov + (targetView.fov - sourceView.fov) * easeProgress(elapsed, moveMs);
        return reading;
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
          return report(nextView, nextView.id, nextView.fov);
        }
        // Start the next glide from the view just held. Returning the destination here flashes it
        // for one frame, then the following frame jumps backwards to the beginning of the glide.
        return report(heldView, nextView.id, heldView.fov);
      }

      return report(targetView, targetView.id, targetView.fov);
    },
  };
}
