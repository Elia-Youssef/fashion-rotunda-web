// Capsule collision against the rotunda geometry.
// Implements the three-mesh-bvh shapecast pattern documented in example/characterMovement.js
// (lines 368-392). The capsule is vertical with its lowest point at foot.y and height equal to
// eye height. Resolves penetrations iteratively so corners and the plinth edge do not snag.
// A resolver owns its workspace: the segment, the bounds box, the temporary points, the
// direction and normal, and the shapecast callbacks. They are created once per resolver and
// reset from the input on every resolve, so a walking step allocates nothing on this path.

import { Box3, Line3, Vector3 } from 'three';
import type { ExtendedTriangle, MeshBVH } from 'three-mesh-bvh';

export interface Capsule {
  radius: number;
  height: number;
}

export interface CapsuleResolver {
  /**
   * Returns the capsule's foot position pushed out of the geometry; the input is never mutated.
   * Writes into `out` when given, otherwise into an owned scratch vector that the next resolve
   * overwrites, so read the result before resolving again. If the resulting foot would be below
   * the floor (y < 0), it is clamped to 0.
   */
  resolve(foot: Vector3, out?: Vector3): Vector3;
}

const MAX_ITERATIONS = 5;
const EPSILON = 1e-6;

/**
 * Creates a resolver for one BVH and one capsule. The resolver's workspace is private to the
 * instance: two resolvers never share scratch, so interleaved or concurrent resolvers cannot
 * corrupt each other's state.
 */
export function createCapsuleResolver(bvh: MeshBVH, capsule: Capsule): CapsuleResolver {
  const { radius, height } = capsule;
  const halfRadius = Math.max(0, radius);
  const topOffset = Math.max(halfRadius, height - halfRadius);

  // Segment endpoints in world coordinates, rewritten from the input on every resolve.
  const segment = new Line3(new Vector3(), new Vector3());

  const tempBox = new Box3();
  const triPoint = new Vector3();
  const capsulePoint = new Vector3();
  const direction = new Vector3();
  const triNormal = new Vector3();
  const result = new Vector3();

  // Set inside the triangle callback while a shapecast iteration runs; the loop resets it.
  let collided = false;

  const callbacks = {
    intersectsBounds: (box: Box3): boolean => box.intersectsBox(tempBox),

    intersectsTriangle: (tri: ExtendedTriangle): void => {
      const distance = tri.closestPointToSegment(segment, triPoint, capsulePoint);
      if (distance < halfRadius - EPSILON) {
        collided = true;
        const depth = halfRadius - distance;
        tri.getNormal(triNormal);
        if (distance > EPSILON) {
          direction.subVectors(capsulePoint, triPoint);
        } else {
          direction.copy(triNormal);
        }
        if (Math.abs(triNormal.y) < 0.7) {
          direction.y = 0;
          if (direction.lengthSq() > EPSILON) {
            direction.normalize();
          } else {
            direction.set(triNormal.x, 0, triNormal.z).normalize();
          }
        } else {
          direction.normalize();
        }
        segment.start.addScaledVector(direction, depth);
        segment.end.addScaledVector(direction, depth);
      }
    },
  };

  return {
    resolve(foot: Vector3, out?: Vector3): Vector3 {
      const target = out ?? result;

      segment.start.set(foot.x, foot.y + halfRadius, foot.z);
      segment.end.set(foot.x, foot.y + topOffset, foot.z);

      for (let iter = 0; iter < MAX_ITERATIONS; iter += 1) {
        collided = false;
        tempBox.makeEmpty();
        tempBox.expandByPoint(segment.start);
        tempBox.expandByPoint(segment.end);
        tempBox.min.addScalar(-halfRadius);
        tempBox.max.addScalar(halfRadius);

        bvh.shapecast(callbacks);

        if (!collided) {
          break;
        }
      }

      const footY = Math.max(0, segment.start.y - halfRadius);
      target.set(segment.start.x, footY, segment.start.z);
      return target;
    },
  };
}

/**
 * One-off form of the resolver: builds a workspace, resolves once and returns a fresh vector.
 * The input is never mutated; if the resulting foot would be below the floor (y < 0), it is
 * clamped to 0. Code that resolves every step should hold one resolver from
 * createCapsuleResolver instead of building a workspace per call.
 */
export function resolveCapsule(bvh: MeshBVH, foot: Vector3, capsule: Capsule): Vector3 {
  return createCapsuleResolver(bvh, capsule).resolve(foot);
}
