// Write fitted positions and rebuild their normal and tangent frames.
import { Vector3 } from 'three';
import { SEAM_TOLERANCE } from './garment-coverage.mjs';
const positionKey = point => point.toArray().map(value => Math.round(value / SEAM_TOLERANCE)).join(',');
export function writeFittedParts(parts) {
  for (const part of parts) {
    const inverse = part.matrix.clone().invert();
    const positions = part.primitive.getAttribute('POSITION');
    const points = part.points.map((point) => point.clone().applyMatrix4(inverse));
    const sums = new Map(), affected = new Set();
    for (let i = 0; i < part.indices.length; i += 3) {
      const abc = part.indices.slice(i, i + 3).map((j) => points[j]);
      const changed = part.indices.slice(i, i + 3).some((j) =>
        !points[j].equals(new Vector3().fromArray(positions.getElement(j, []))));
      const normal = new Vector3().subVectors(abc[1], abc[0]).cross(new Vector3().subVectors(abc[2], abc[0]));
      for (const point of abc) {
        const key = positionKey(point), sum = sums.get(key) ?? new Vector3();
        sum.add(normal); sums.set(key, sum);
        if (changed) affected.add(key);
      }
    }
    const normals = part.primitive.getAttribute('NORMAL');
    const tangents = part.primitive.getAttribute('TANGENT');
    for (const [i, point] of points.entries()) {
      positions.setElement(i, point.toArray());
      if (!affected.has(positionKey(point))) continue;
      const normal = sums.get(positionKey(point)).clone().normalize();
      if (normals) normals.setElement(i, normal.toArray());
      if (tangents) {
        const value = tangents.getElement(i, []), tangent = new Vector3().fromArray(value);
        tangent.addScaledVector(normal, -tangent.dot(normal)).normalize();
        tangents.setElement(i, [...tangent.toArray(), value[3]]);
      }
    }
  }
}

