// Blended camera switch between inspection and walkthrough.
// Smoothly eases camera position and look-at target from one mode's stored pose to the other's
// over BLEND_MS (700 ms). Reduced motion uses 0 ms (instant cut).

export interface Pose {
  position: [number, number, number];
  target: [number, number, number];
}

export const BLEND_MS = 700;

/**
 * Standard cubic ease in-out curve.
 * Monotonic on [0, 1], starting and ending with zero acceleration.
 */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Copies the six numbers of `source` into `destination`. The one pose copy for every module. */
export function copyPose(source: Pose, destination: Pose): void {
  destination.position[0] = source.position[0];
  destination.position[1] = source.position[1];
  destination.position[2] = source.position[2];
  destination.target[0] = source.target[0];
  destination.target[1] = source.target[1];
  destination.target[2] = source.target[2];
}

/**
 * Writes the blend of `from` and `to` into `destination` and returns it. t in [0, 1], eased in
 * and out; t = 0 writes `from` exactly, t = 1 writes `to` exactly. The sources are never
 * mutated, and `destination` may be one of them: every component is read before it is written,
 * so an aliased write cannot corrupt the endpoint it is reading. Callers on a frame path own
 * one destination and reuse it every frame.
 */
export function blendPoseInto(from: Pose, to: Pose, t: number, destination: Pose): Pose {
  if (t <= 0) {
    copyPose(from, destination);
    return destination;
  }
  if (t >= 1) {
    copyPose(to, destination);
    return destination;
  }

  const factor = easeInOutCubic(t);
  destination.position[0] = from.position[0] + (to.position[0] - from.position[0]) * factor;
  destination.position[1] = from.position[1] + (to.position[1] - from.position[1]) * factor;
  destination.position[2] = from.position[2] + (to.position[2] - from.position[2]) * factor;
  destination.target[0] = from.target[0] + (to.target[0] - from.target[0]) * factor;
  destination.target[1] = from.target[1] + (to.target[1] - from.target[1]) * factor;
  destination.target[2] = from.target[2] + (to.target[2] - from.target[2]) * factor;
  return destination;
}

/**
 * Allocating form of blendPoseInto for callers and tests that need an independent snapshot.
 */
export function blendPose(from: Pose, to: Pose, t: number): Pose {
  return blendPoseInto(from, to, t, { position: [0, 0, 0], target: [0, 0, 0] });
}
