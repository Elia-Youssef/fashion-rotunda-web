// The attract loop glides from the live camera onto one continuous orbit after user inactivity.
// Any user input stops the tour immediately and restarts the idle clock.
// Reduced motion prevents the tour and stops it immediately. Disabled by default on touch.

import { copyPose, easeInOutCubic } from './blend';
import type { Pose } from './blend';

// Wait a minute so the idle tour does not interrupt inspection.
export const ATTRACT_IDLE_MS = 60_000;
// Ease onto the circle over three seconds to avoid a sudden camera change.
export const ATTRACT_MOVE_MS = 3_000;
// A 5 m radius sits inside the measured clear annulus, 1.5 m to 7.1 m from the plinth axis.
export const ATTRACT_RADIUS_M = 5.0;
// A 2 m camera clears the 0.15 m plinth and frames the 1.55 m to 1.94 m looks.
export const ATTRACT_HEIGHT_M = 2.0;
// Aim at 1.1 m to centre the looks above the 0.15 m plinth.
export const ATTRACT_TARGET_HEIGHT_M = 1.1;
// A 50 degree vertical view leaves room around the tallest 1.94 m look at 5 m.
export const ATTRACT_FOV_DEG = 50;
// One minute per revolution gives every side of the look a slow inspection.
export const ATTRACT_PERIOD_MS = 60_000;

export interface AttractOptions {
  /** Writes the live pose and FOV once at each idle start; the destination is owned here. */
  readStart: (destination: AttractReading) => void;
  idleMs: number;
  moveMs: number;
  enabled: boolean; // false by default on touch; ?attract=1|0 overrides
  reducedMotion: boolean; // prevents the tour independently of its enabled setting
  now?: () => number;
  /** The idle deadline or its eligibility changed outside a tick. */
  onWaitChange?: () => void;
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
  /** Remaining idle wait, or null when no tour can start or a tour already owns the camera. */
  msUntilStart(): number | null;
  /**
   * Called every frame while running or waiting; returns the pose to show, or null to leave the
   * camera. The reading is owned by the handle and rewritten by the next tick, so a caller
   * consumes it before ticking again and copies it if it must outlive the tick.
   */
  tick(): AttractReading | null;
}

function easeProgress(elapsedMs: number, durationMs: number): number {
  const t = durationMs > 0 ? Math.min(1, Math.max(0, elapsedMs / durationMs)) : 1;
  return easeInOutCubic(t);
}

export function createAttract(options: AttractOptions): AttractHandle {
  const { idleMs, moveMs } = options;
  const now = options.now ?? ((): number => performance.now());

  let isEnabled = options.enabled;
  let isReducedMotion = options.reducedMotion;
  let isRunning = false;
  let lastInputTime = now();

  let startTime = 0;
  let startTheta = 0;
  let startRadius = 0;
  const angularSpeed = 2 * Math.PI / ATTRACT_PERIOD_MS;

  // The tick reading and its pose are owned here and written in place: a tour frame must not
  // allocate a pose, a result object or an array.
  const reading: AttractReading = {
    pose: { position: [0, 0, 0], target: [0, 0, 0] },
    viewId: 'orbit',
    fov: 0,
  };

  const start: AttractReading = {
    pose: { position: [0, 0, 0], target: [0, 0, 0] }, viewId: 'orbit', fov: 0,
  };

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
      options.onWaitChange?.();
    },

    setReducedMotion(reduced: boolean): void {
      if (isReducedMotion === reduced) return;
      isReducedMotion = reduced;
      // A preference change ends the old tour; returning to normal motion starts a fresh idle wait.
      stop();
      options.onWaitChange?.();
    },

    noteInput(): void {
      stop();
      options.onWaitChange?.();
    },

    msUntilStart(): number | null {
      if (!isEnabled || isReducedMotion || isRunning) return null;
      return Math.max(0, idleMs - (now() - lastInputTime));
    },

    tick(): AttractReading | null {
      if (!isEnabled || isReducedMotion) {
        return null;
      }

      const currentTime = now();

      if (!isRunning) {
        if (currentTime - lastInputTime >= idleMs) {
          options.readStart(start);
          isRunning = true;
          startTime = currentTime;
          startTheta = Math.atan2(start.pose.position[0], start.pose.position[2]);
          startRadius = Math.hypot(start.pose.position[0], start.pose.position[2]);
        } else {
          return null;
        }
      }

      const elapsed = Math.max(0, currentTime - startTime);
      if (elapsed === 0 && moveMs > 0) {
        copyPose(start.pose, reading.pose);
        reading.fov = start.fov;
        return reading;
      }

      const t = moveMs > 0 ? Math.min(1, elapsed / moveMs) : 1;
      const eased = easeProgress(elapsed, moveMs);
      // Integrate smoothstep velocity (3t^2 - 2t^3): zero speed at launch, full speed at arrival.
      // The integral reaches half the glide duration; continue from there without a speed jump.
      const angularTime = elapsed < moveMs
        ? moveMs * (t * t * t - t * t * t * t / 2)
        : elapsed - moveMs / 2;
      const theta = startTheta + angularSpeed * angularTime;
      const radius = startRadius + (ATTRACT_RADIUS_M - startRadius) * eased;
      reading.pose.position[0] = radius * Math.sin(theta);
      reading.pose.position[1] = start.pose.position[1] + (ATTRACT_HEIGHT_M - start.pose.position[1]) * eased;
      reading.pose.position[2] = radius * Math.cos(theta);
      reading.pose.target[0] = start.pose.target[0] * (1 - eased);
      reading.pose.target[1] = start.pose.target[1] + (ATTRACT_TARGET_HEIGHT_M - start.pose.target[1]) * eased;
      reading.pose.target[2] = start.pose.target[2] * (1 - eased);
      reading.fov = start.fov + (ATTRACT_FOV_DEG - start.fov) * eased;
      return reading;
    },
  };
}
