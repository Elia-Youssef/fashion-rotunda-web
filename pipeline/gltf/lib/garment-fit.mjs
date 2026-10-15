// Static garment/body fitting belongs before texture encoding and meshopt quantization. A look's
// opt-in policy selects the surfaces; the geometry solver never branches on asset identity.
import {
  combinedSurface, CONTACT_TOLERANCE, createCoverage, faceSamples, FIT_MARGIN,
  SEAM_TOLERANCE, surfaceParts, measureSurface,
} from './garment-coverage.mjs';
import { writeFittedParts } from './garment-attributes.mjs';
import { fitContactClearance } from './garment-shape.mjs';
import { measureNormalVertices } from './garment-measurement.mjs';
import { assertNoSurfaceIntersections } from './garment-intersection.mjs';

/** Later covered intervals took 31 passes in the measured repair. Sixty-four bounds that
 *  advancing face boundary with room for quantization, without allowing a partial output. */
export const MAX_FIT_PASSES = 64;

/** The selected coarse shell separates limb contacts while fitting only its covered torso. */
export const LOOK_FIT_POLICIES = {
  'mondrian-dress': { garmentGroup: 'garment', bodyGroup: 'mannequin', method: 'contact-clearance' },
};

const positionKey = (p) => p.toArray().map((v) => Math.round(v / SEAM_TOLERANCE)).join(',');

/**
 * Fits either the shell outward or its covered body inward, preserving topology and openings.
 * The original body intervals stay fixed. A limb wholly beyond the garment remains exposed;
 * intersecting intervals follow the selected coverage policy. No body face is removed.
 */
export function fitCoveredSurface(garmentParts, bodyParts, method = 'garment-outward', coverageOptions = {}, margin = FIT_MARGIN) {
  if (!['garment-outward', 'body-inward'].includes(method)) throw new Error(`Unknown fit method ${method}`);
  const reference = createCoverage(combinedSurface(garmentParts), combinedSurface(bodyParts), null, coverageOptions);
  const referenceBody = combinedSurface(bodyParts);
  const moving = method === 'garment-outward' ? garmentParts : bodyParts;
  const original = moving.map((part) => part.points.map((point) => point.clone()));
  const history = [];
  for (let pass = 0; pass <= MAX_FIT_PASSES; pass++) {
    const current = method === 'garment-outward'
      ? createCoverage(combinedSurface(garmentParts), referenceBody, null, coverageOptions) : reference;
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
          // The hit indexes the same merged parts walked above; inward fitting uses abc directly.
          // Refuse a broken face-to-part mapping rather than applying an incomplete correction.
          if (!vertices?.length) throw new Error(`Penetrating face has no covered vertex; fit refused at ${JSON.stringify(abc.map((p) => p.toArray()))}`);
          const distance = q.depth + margin;
          for (const vertex of vertices) {
            // Each corner follows its own horizontal radial direction. Using one sample's
            // direction for the whole triangle can push another corner sideways out of the shell.
            const center = current.centerAt(vertex.y) ?? q.center;
            const direction = vertex.clone().sub(center); direction.y = 0;
            const radius = direction.length(); direction.normalize();
            // Covered interiors can belong to a face whose corners were previously exposed.
            // Project those corners against their own shell exit instead of applying only the
            // interior sample's smaller depth and advancing one small face at a time.
            const shellRadius = current.shellRadiusAt(vertex);
            const cornerDistance = method === 'body-inward' && shellRadius !== null
              ? Math.max(distance, radius - shellRadius + margin) : distance;
            // A face-wide inward correction must never cross the section centre and emerge
            // on the opposite side. Short-radius corners stop inside the same radial half-line.
            const movement = method === 'body-inward' ? Math.min(cornerDistance, Math.max(0, radius - FIT_MARGIN)) : distance;
            const delta = direction.clone().multiplyScalar(method === 'garment-outward' ? movement : -movement);
            const key = positionKey(vertex);
            const previous = proposals.get(key);
            if (!previous || previous.distance < movement) proposals.set(key, { delta, distance: movement });
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

/** Named opt-in at the pipeline boundary; all other looks return without modifying their graph. */
export function applyLookFit(document, lookId, method = null) {
  const policy = LOOK_FIT_POLICIES[lookId];
  if (!policy) return { applied: false };
  const garmentParts = surfaceParts(document, policy.garmentGroup);
  const bodyParts = surfaceParts(document, policy.bodyGroup);
  const selected = method ?? policy.method;
  const result = selected === 'contact-clearance'
    ? fitContactClearance(garmentParts, bodyParts)
    : fitCoveredSurface(garmentParts, bodyParts, selected, policy.coverage, policy.margin);
  writeFittedParts(selected === 'body-inward' ? bodyParts : garmentParts);
  return { applied: true, method: selected, ...result };
}

/** Checks the serialized surface after meshopt quantization, using the original body intervals. */
export function validateFitOutput(document, fit) {
  if (!fit.applied) return { checked: false };
  const garment = surfaceParts(document, 'garment'), body = surfaceParts(document, 'mannequin');
  if (fit.method === 'contact-clearance') {
    assertNoSurfaceIntersections(garment);
    // Whole radial intervals can reach past an opening along an exposed limb. Local normal
    // contacts provide the contact gate; the exact protection and shape guards run before encoding.
    const measurement = measureNormalVertices(garment, body);
    if (measurement.outsideVertices !== 0) {
      throw new Error(`Serialized garment fit failed: ${measurement.outsideVertices} outside vertices`);
    }
    return { checked: true, ...measurement };
  }
  const coverage = createCoverage(combinedSurface(garment), fit.referenceBody, null, fit.reference.options);
  const measurement = measureSurface(body, coverage);
  if (measurement.outsideSamples !== 0) {
    throw new Error(`Serialized garment fit failed: ${measurement.outsideSamples} outside samples on ` +
      `${measurement.penetratingFaces} body faces`);
  }
  return { checked: true, ...measurement };
}
