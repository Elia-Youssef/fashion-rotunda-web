// Static garment/body fitting belongs before texture encoding and meshopt quantization. A look's
// opt-in policy selects the surfaces; the geometry solver never branches on asset identity.
import { Vector3 } from 'three';
import {
  combinedSurface, CONTACT_TOLERANCE, createCoverage, faceSamples, FIT_MARGIN,
  SEAM_TOLERANCE, surfaceParts, measureSurface,
} from './garment-coverage.mjs';

/** Bounded convergence prevents a new source mesh from silently shipping a partial repair. */
export const MAX_FIT_PASSES = 16;

/** Only this open, coarse shell has a measured body intersection requiring an offline fit. */
export const LOOK_FIT_POLICIES = {
  'mondrian-dress': { garmentGroup: 'garment', bodyGroup: 'mannequin', method: 'body-inward' },
};

const positionKey = (p) => p.toArray().map((v) => Math.round(v / SEAM_TOLERANCE)).join(',');

/**
 * Fits either the shell outward or its covered body inward, preserving topology and openings.
 * The original body intervals stay fixed. A separate limb beyond the first interval cannot
 * become part of the fitted torso. No body face is removed, including at garment openings.
 */
export function fitCoveredSurface(garmentParts, bodyParts, method = 'garment-outward') {
  if (!['garment-outward', 'body-inward'].includes(method)) throw new Error(`Unknown fit method ${method}`);
  const reference = createCoverage(combinedSurface(garmentParts), combinedSurface(bodyParts));
  const referenceBody = combinedSurface(bodyParts);
  const moving = method === 'garment-outward' ? garmentParts : bodyParts;
  const original = moving.map((part) => part.points.map((point) => point.clone()));
  const history = [];
  for (let pass = 0; pass <= MAX_FIT_PASSES; pass++) {
    const current = method === 'garment-outward'
      ? createCoverage(combinedSurface(garmentParts), referenceBody) : reference;
    const proposals = new Map();
    let outsideSamples = 0, maxDepth = 0;
    for (const part of bodyParts) {
      for (let i = 0; i < part.indices.length; i += 3) {
        const abc = part.indices.slice(i, i + 3).map((j) => part.points[j]);
        for (const sample of faceSamples(...abc)) {
          const q = current.query(sample);
          if (!q || q.depth <= CONTACT_TOLERANCE) continue;
          outsideSamples++; maxDepth = Math.max(maxDepth, q.depth);
          let vertices;
          if (method === 'garment-outward') {
            let face = q.faceIndex;
            for (const garmentPart of garmentParts) {
              if (face < garmentPart.indices.length / 3) {
                vertices = garmentPart.indices.slice(face * 3, face * 3 + 3).map((j) => garmentPart.points[j]);
                break;
              }
              face -= garmentPart.indices.length / 3;
            }
          } else {
            // A covered triangle interior can penetrate even when its corners straddle an
            // opening. Correct its complete face while retaining every body face and opening.
            vertices = abc;
          }
          if (!vertices?.length) throw new Error(`Penetrating face has no covered vertex; fit refused at ${JSON.stringify(abc.map((p) => p.toArray()))}`);
          const distance = q.depth + FIT_MARGIN;
          for (const vertex of vertices) {
            const direction = method === 'garment-outward'
              ? vertex.clone().sub(current.centerAt(vertex.y)).normalize() : q.direction;
            const delta = direction.clone().multiplyScalar(method === 'garment-outward' ? distance : -distance);
            const key = positionKey(vertex);
            const previous = proposals.get(key);
            if (!previous || previous.distance < distance) proposals.set(key, { delta, distance });
          }
        }
      }
    }
    history.push({ pass, outsideSamples, maxDepthMm: maxDepth * 1000 });
    if (outsideSamples === 0) {
      let movedVertices = 0, maxDisplacement = 0;
      for (const [partIndex, part] of moving.entries()) {
        for (const [i, point] of part.points.entries()) {
          const distance = point.distanceTo(original[partIndex][i]);
          if (distance > 0) movedVertices++;
          maxDisplacement = Math.max(maxDisplacement, distance);
        }
      }
      return { reference, referenceBody, history, movedVertices, maxDisplacementMm: maxDisplacement * 1000 };
    }
    if (pass === MAX_FIT_PASSES) break;
    // Seams share the same proposal, even when UVs or authored normals split their accessors.
    for (const part of moving) {
      for (const point of part.points) {
        const proposal = proposals.get(positionKey(point));
        if (proposal) point.add(proposal.delta);
      }
    }
  }
  throw new Error(`Garment fit did not converge: ${JSON.stringify(history)}`);
}

/** Rebuild area-weighted normals across position seams and keep tangent frames orthogonal. */
function writeFittedParts(parts) {
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

/** Named opt-in at the pipeline boundary; all other looks return without modifying their graph. */
export function applyLookFit(document, lookId, method = null) {
  const policy = LOOK_FIT_POLICIES[lookId];
  if (!policy) return { applied: false };
  const garmentParts = surfaceParts(document, policy.garmentGroup);
  const bodyParts = surfaceParts(document, policy.bodyGroup);
  const selected = method ?? policy.method;
  const result = fitCoveredSurface(garmentParts, bodyParts, selected);
  writeFittedParts(selected === 'garment-outward' ? garmentParts : bodyParts);
  return { applied: true, method: selected, ...result };
}

/** Checks the serialized surface after meshopt quantization, using the original body intervals. */
export function validateFitOutput(document, fit) {
  if (!fit.applied) return { checked: false };
  const garment = surfaceParts(document, 'garment'), body = surfaceParts(document, 'mannequin');
  const coverage = createCoverage(combinedSurface(garment), fit.referenceBody);
  const measurement = measureSurface(body, coverage);
  if (measurement.outsideSamples !== 0) {
    throw new Error(`Serialized garment fit failed: ${measurement.outsideSamples} outside samples on ` +
      `${measurement.penetratingFaces} body faces`);
  }
  return { checked: true, ...measurement };
}
