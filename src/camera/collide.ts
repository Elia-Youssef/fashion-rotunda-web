// Goal G4.2: capsule collision against the rotunda geometry.
// Implements the three-mesh-bvh shapecast pattern documented in example/characterMovement.js
// (lines 368-392). The capsule is vertical with its lowest point at foot.y and height equal to
// eye height. Resolves penetrations iteratively so corners and the plinth edge do not snag.

import { Box3, Line3, Vector3 } from 'three';
import type { MeshBVH } from 'three-mesh-bvh';

export interface Capsule {
  radius: number;
  height: number;
}

const MAX_ITERATIONS = 5;
const EPSILON = 1e-6;

/**
 * Returns the capsule's foot position pushed out of the geometry; the input is never mutated.
 * If the resulting foot would be below the floor (y < 0), it is clamped to 0.
 */
export function resolveCapsule(bvh: MeshBVH, foot: Vector3, capsule: Capsule): Vector3 {
  const { radius, height } = capsule;
  const halfRadius = Math.max(0, radius);
  const topOffset = Math.max(halfRadius, height - halfRadius);

  // Segment endpoints in world coordinates.
  const segment = new Line3(
    new Vector3(foot.x, foot.y + halfRadius, foot.z),
    new Vector3(foot.x, foot.y + topOffset, foot.z),
  );

  const tempBox = new Box3();
  const triPoint = new Vector3();
  const capsulePoint = new Vector3();
  const direction = new Vector3();
  const triNormal = new Vector3();

  for (let iter = 0; iter < MAX_ITERATIONS; iter += 1) {
    tempBox.makeEmpty();
    tempBox.expandByPoint(segment.start);
    tempBox.expandByPoint(segment.end);
    tempBox.min.addScalar(-halfRadius);
    tempBox.max.addScalar(halfRadius);

    let collided = false;

    bvh.shapecast({
      intersectsBounds: (box) => box.intersectsBox(tempBox),
      intersectsTriangle: (tri) => {
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
    });

    if (!collided) {
      break;
    }
  }

  const footY = Math.max(0, segment.start.y - halfRadius);
  return new Vector3(segment.start.x, footY, segment.start.z);
}
