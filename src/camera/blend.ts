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

/**
 * Linearly interpolates two 3D vectors.
 */
function lerpVector3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  factor: number,
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * factor,
    a[1] + (b[1] - a[1]) * factor,
    a[2] + (b[2] - a[2]) * factor,
  ];
}

/**
 * t in [0, 1], eased in and out; t = 0 returns `from` exactly, t = 1 returns `to` exactly.
 */
export function blendPose(from: Pose, to: Pose, t: number): Pose {
  if (t <= 0) {
    return {
      position: [from.position[0], from.position[1], from.position[2]],
      target: [from.target[0], from.target[1], from.target[2]],
    };
  }
  if (t >= 1) {
    return {
      position: [to.position[0], to.position[1], to.position[2]],
      target: [to.target[0], to.target[1], to.target[2]],
    };
  }

  const factor = easeInOutCubic(t);
  return {
    position: lerpVector3(from.position, to.position, factor),
    target: lerpVector3(from.target, to.target, factor),
  };
}
