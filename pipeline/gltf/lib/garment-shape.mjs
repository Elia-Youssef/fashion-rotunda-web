// Bounded garment contact separation preserves protected body vertices and garment openings.
import { DoubleSide, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import {
  combinedSurface, CONTACT_TOLERANCE, createCoverage, faceSamples, FIT_MARGIN, SEAM_TOLERANCE,
} from './garment-coverage.mjs';
import { measureNormalVertices } from './garment-measurement.mjs';
import { writeFittedParts } from './garment-attributes.mjs';
import { assertNoSurfaceIntersections } from './garment-intersection.mjs';

/** Forty millimetres accommodates the local hand contact without changing the
 *  dress by the much larger depths produced by a ray crossing an entire forearm. */
export const MAX_GARMENT_DISPLACEMENT = 0.04;
/** A static refit may stretch or compress an edge by at most a factor of 1.5. This generous
 *  shape limit still rejects the multiple-fold edge expansion caused by isolated vertex spikes. */
export const MAX_GARMENT_EDGE_RATIO = 1.5;
/** A 200 mm surface neighbourhood spreads a hand contact beyond its supporting triangle. */
const GARMENT_FALLOFF_RADIUS = 0.2;
/** Four edge lengths keep the contact face inside the smooth support. */
const MIN_CONTACT_SUPPORT_EDGES = 4;
/** Gradient-constrained contacts settle gradually; the finite bound refuses a partial result. */
const MAX_SHELL_PASSES = 128;
/** Sixteen initial torso passes match the established covered-surface prefit. */
const MAX_TORSO_PASSES = 16;
/** Five percent strain headroom accommodates serialized quantization on short edges. */
const EDGE_RATIO_HEADROOM = 0.95;
/** A finite projection solve refuses an unresolved spike instead of shipping it. */
const MAX_FALLOFF_PASSES = 2048;
/** Ten micrometres is below contact tolerance; actual edge ratios are checked after projection. */
const FALLOFF_TOLERANCE = CONTACT_TOLERANCE / 10;

const key = point => point.toArray().map(v => Math.round(v / SEAM_TOLERANCE)).join(',');
/** Separate from the nearest protected body boundary. An exterior point continues away
 *  from that body, rather than being pulled back into it. */
function closestBodyExit(surface, point, outward) {
  const closest = surface.closestPointToPoint(point);
  if (!closest) throw new Error('Body contact has no nearest surface');
  const delta = closest.point.clone().sub(point), distance = delta.length();
  const direction = distance > SEAM_TOLERANCE ? delta.divideScalar(distance) : outward.clone();
  const hit = surface.raycastFirst(new Ray(point, direction), DoubleSide);
  if (hit && hit.face.normal.dot(direction) < 0) direction.negate();
  return { direction, depth: distance };
}

/** Fit only original first-interval torso vertices. Every excluded limb vertex stays exact.
 *  The garment-only contact stage handles triangles straddling protected intervals. */
function fitCoveredTorso(garmentParts, bodyParts) {
  const coverage = createCoverage(combinedSurface(garmentParts), combinedSurface(bodyParts));
  const allowed = new Set(bodyParts.flatMap(part => part.points.filter(point => coverage.query(point))));
  const original = new Map([...allowed].map(point => [point, point.clone()]));
  for (let pass = 0; pass < MAX_TORSO_PASSES; pass++) {
    const proposals = new Map();
    for (const part of bodyParts) for (let i = 0; i < part.indices.length; i += 3) {
      const abc = part.indices.slice(i, i + 3).map(j => part.points[j]);
      for (const sample of faceSamples(...abc)) {
        const q = coverage.query(sample); if (!q || q.depth <= CONTACT_TOLERANCE) continue;
        for (const point of abc) {
          if (!allowed.has(point)) continue;
          const direction = point.clone().sub(coverage.centerAt(point.y)); direction.y = 0;
          const radius = direction.length(); direction.normalize();
          const shell = coverage.shellRadiusAt(point);
          const distance = Math.min(Math.max(q.depth + FIT_MARGIN, shell === null ? 0 : radius - shell + FIT_MARGIN), Math.max(0, radius - FIT_MARGIN));
          const previous = proposals.get(point);
          if (!previous || previous.distance < distance) proposals.set(point, {distance, direction});
        }
      }
    }
    if (!proposals.size) break;
    for (const [point, proposal] of proposals) point.addScaledVector(proposal.direction, -proposal.distance);
  }
  return { movedVertices: [...allowed].filter(point => !point.equals(original.get(point))).length };

}

export function snapshotSurfaces(garment, body) {
  const snapshot = parts => parts.map(part => ({ points: part.points.map(p => p.clone()), indices: [...part.indices] }));
  return { garment: snapshot(garment), body: snapshot(body) };
}

/** Tests actual positions, edge lengths and topology, independently of penetration depth. */
export function validateSurfaceShape(garment, body, before) {
  let maxDisplacement = 0, maxEdgeRatio = 1;
  for (const [i, part] of body.entries()) {
    if (part.points.some((point, j) => (before.protectedBody?.[i][j] ?? true) && !point.equals(before.body[i].points[j]))) {
      throw new Error('Protected body vertex moved during garment fitting');
    }
  }
  for (const [i, part] of garment.entries()) {
    const original = before.garment[i];
    if (part.indices.length !== original.indices.length || part.indices.some((value, j) => value !== original.indices[j])) {
      throw new Error('Garment fitting changed topology or openings');
    }
    for (const [j, point] of part.points.entries()) maxDisplacement = Math.max(maxDisplacement, point.distanceTo(original.points[j]));
    for (let j = 0; j < part.indices.length; j += 3) {
      const ids = part.indices.slice(j, j + 3);
      for (let edge = 0; edge < 3; edge++) {
        const a = ids[edge], b = ids[(edge + 1) % 3];
        const oldLength = original.points[a].distanceTo(original.points[b]);
        const newLength = part.points[a].distanceTo(part.points[b]);
        if (oldLength <= SEAM_TOLERANCE) continue;
        maxEdgeRatio = Math.max(maxEdgeRatio, newLength / oldLength, oldLength / newLength);
      }
      const normal = points => new Vector3().subVectors(points[ids[1]], points[ids[0]])
        .cross(new Vector3().subVectors(points[ids[2]], points[ids[0]]));
      if (normal(part.points).length() <= SEAM_TOLERANCE ** 2) throw new Error('Garment fitting collapsed a face');
    }
  }
  if (maxDisplacement > MAX_GARMENT_DISPLACEMENT + SEAM_TOLERANCE) throw new Error('Garment displacement bound exceeded');
  if (maxEdgeRatio > MAX_GARMENT_EDGE_RATIO) throw new Error('Garment edge ratio bound exceeded');
  return { maxDisplacementMm: maxDisplacement * 1000, maxEdgeRatio, protectedBodyVerticesMoved: 0 };
}

/** Compact C2 falloff has zero slope at the centre and support boundary. */
function garmentFalloff(distance, radius) {
  const t = Math.min(1, Math.max(0, distance / radius));
  return (1 - t) ** 4 * (1 + 4 * t);
}

/** Projects the falloff field onto bounded neighbour gradients without changing topology. */
export function constrainGarmentFalloff(offsets, neighbors, points, pinned = new Set()) {
  for (const id of pinned) offsets[id].set(0, 0, 0);
  const edges = [];
  for (let a = 0; a < neighbors.length; a++) for (const [b, length] of neighbors[a]) if (a < b) edges.push([a, b, length]);
  const ratio = 1 + (MAX_GARMENT_EDGE_RATIO - 1) * EDGE_RATIO_HEADROOM;
  for (let pass = 0; pass < MAX_FALLOFF_PASSES; pass++) {
    let excess = 0;
    for (const [a, b, length] of edges) {
      const difference = points[b].clone().add(offsets[b]).sub(points[a]).sub(offsets[a]);
      const distance = difference.length(), target = Math.max(length / ratio, Math.min(length * ratio, distance));
      if (distance === target) continue;
      excess = Math.max(excess, Math.abs(distance - target));
      const correction = distance > SEAM_TOLERANCE
        ? difference.multiplyScalar((distance - target) / (2 * distance))
        : points[b].clone().sub(points[a]).normalize().multiplyScalar(-target / 2);
      if (pinned.has(a) && pinned.has(b)) continue;
      if (pinned.has(a)) offsets[b].addScaledVector(correction, -2);
      else if (pinned.has(b)) offsets[a].addScaledVector(correction, 2);
      else { offsets[a].add(correction); offsets[b].sub(correction); }
    }
    if (excess <= FALLOFF_TOLERANCE) return;
  }
  throw new Error('Garment falloff did not meet the edge gradient bound');
}

/** Protected body positions are unchanged. Only local shell offsets near measured normal contacts are changed. */
export function fitSmoothGarment(garmentParts, bodyParts, coverageOptions = {}, adjustment = null) {
  const before = snapshotSurfaces(garmentParts, bodyParts);
  if (adjustment) before.protectedBody = adjustment.protectedBody;
  const referenceBody = adjustment?.referenceBody ?? combinedSurface(bodyParts);
  const originalGeometry = combinedSurface(garmentParts);
  const reference = adjustment?.reference ?? createCoverage(originalGeometry, referenceBody, null, coverageOptions);
  const points = [], ids = new Map(), parts = [], triangles = [];
  for (const part of garmentParts) {
    const mapping = part.points.map(point => {
      const value = key(point);
      if (!ids.has(value)) { ids.set(value, points.length); points.push(point.clone()); }
      return ids.get(value);
    });
    parts.push(mapping);
    for (let i = 0; i < part.indices.length; i += 3) triangles.push(part.indices.slice(i, i + 3).map(j => mapping[j]));
  }
  const pinned = new Set(reference.topology.loops.flatMap(loop => loop.vertices));
  const neighbors = points.map(() => new Map());
  for (const triangle of triangles) for (let i = 0; i < 3; i++) {
    const a = triangle[i], b = triangle[(i + 1) % 3], length = points[a].distanceTo(points[b]);
    neighbors[a].set(b, length); neighbors[b].set(a, length);
  }
  const offsets = points.map(() => new Vector3()), history = [];
  const kernels = new Map();
  function distances(face, center, radius) {
    const distances = points.map(() => Infinity), pending = new Set();
    for (const id of face) { distances[id] = points[id].distanceTo(center); pending.add(id); }
    while (pending.size) {
      let next = -1, minimum = Infinity;
      for (const id of pending) if (distances[id] < minimum) { next = id; minimum = distances[id]; }
      pending.delete(next); if (minimum > radius) continue;
      for (const [id, length] of neighbors[next]) {
        const distance = minimum + length;
        if (distance <= radius && distance < distances[id]) { distances[id] = distance; pending.add(id); }
      }
    }
    return distances;
  }
  for (let pass = 0; pass <= MAX_SHELL_PASSES; pass++) {
    if (adjustment) adjustment.update(garmentParts, bodyParts, reference);
    const contactBody = adjustment ? bodyParts.map((part, i) => ({ ...part,
      indices: part.indices.filter((_, j) => part.indices.slice(Math.floor(j / 3) * 3, Math.floor(j / 3) * 3 + 3)
        .some(id => adjustment.protectedBody[i][id])) })) : bodyParts;
    const bodySurface = new MeshBVH(combinedSurface(contactBody), { indirect: true });
    const geometry = combinedSurface(garmentParts);
    const garment = new MeshBVH(geometry, { indirect: true }), contacts = new Map();
    const normal = measureNormalVertices(garmentParts, bodyParts);
    const normalOutside = normal.outsideVertices;
    for (const sample of normal.samples) {
        if (!sample.outside) continue;
        const direction = new Vector3().fromArray(sample.normal);
        const hit = garment.raycastFirst(new Ray(new Vector3().fromArray(sample.point), direction.clone().negate()), DoubleSide);
        // An outside sample already had an inward hit on these unchanged garment parts. Refuse
        // inconsistent measurement/contact geometry instead of silently skipping its correction.
        if (!hit) throw new Error('Normal contact lost its garment hit');
        const exit = closestBodyExit(bodySurface, hit.point, direction), previous = contacts.get(hit.faceIndex);
        if (!previous || previous.depth < exit.depth) contacts.set(hit.faceIndex, exit);
    }
    history.push({ pass, outsideVertices: normalOutside,
      maxDepthMm: Math.max(0, ...normal.samples.filter(sample => sample.outside).map(sample => sample.depthMm)) });
    if (normalOutside === 0) {
      const shape = validateSurfaceShape(garmentParts, bodyParts, before);
      return { reference, referenceBody, history, shape, shapeReference: before,
        movedVertices: offsets.filter(value => value.lengthSq() > 0).length, maxDisplacementMm: shape.maxDisplacementMm,
        normalMeasurement: normal };
    }
    if (pass === MAX_SHELL_PASSES) break;
    const proposed = points.map(() => new Vector3()), weights = points.map(() => 0);
    for (const [faceIndex, { depth, direction }] of contacts) {
      const face = triangles[faceIndex];
      if (!kernels.has(faceIndex)) {
        const radius = Math.max(GARMENT_FALLOFF_RADIUS,
          ...face.map(a => Math.max(...face.map(b => points[a].distanceTo(points[b]))) * MIN_CONTACT_SUPPORT_EDGES));
        const center = face.reduce((sum, id) => sum.add(points[id]), new Vector3()).divideScalar(3);
        kernels.set(faceIndex, distances(face, center, radius).map(distance => garmentFalloff(distance, radius)));
      }
      const kernel = kernels.get(faceIndex);
      const minimumWeight = Math.min(...face.map(id => kernel[id]));
      const amplitude = (depth + FIT_MARGIN) / minimumWeight;
      for (let id = 0; id < points.length; id++) {
        proposed[id].addScaledVector(direction, amplitude * kernel[id]); weights[id] += kernel[id];
      }
    }
    for (let i = 0; i < offsets.length; i++) offsets[i].addScaledVector(proposed[i], 0.5 / Math.max(1, weights[i]));
    constrainGarmentFalloff(offsets, neighbors, points, pinned);
    for (const [partIndex, part] of garmentParts.entries()) for (const [i, point] of part.points.entries()) {
      const id = parts[partIndex][i]; point.copy(points[id]).add(offsets[id]);
    }
    validateSurfaceShape(garmentParts, bodyParts, before);
  }
  throw new Error('Smooth garment fitting did not converge: ' + JSON.stringify(history));
}

/** Move only the original covered torso vertices as the neighbouring shell clears a limb. */
function followCoveredTorso(garment, body, reference, protectedBody) {
  const coverage = createCoverage(combinedSurface(garment), combinedSurface(body));
  for (const [i, part] of body.entries()) for (const [j, point] of part.points.entries()) {
    if (protectedBody[i][j]) continue;
    const center = coverage.centerAt(point.y);
    if (!center) continue;
    const shell = coverage.shellRadiusAt(point);
    if (shell === null) continue;
    const direction = point.clone().sub(center); direction.y = 0;
    const radius = direction.length(); direction.normalize();
    const movement = Math.min(radius - FIT_MARGIN, Math.max(0, radius - shell + FIT_MARGIN));
    if (movement > 0) point.addScaledVector(direction, -movement);
  }
  const anchored = createCoverage(combinedSurface(garment), combinedSurface(body), reference);
  const proposals = new Map();
  for (const [i, part] of body.entries()) for (let j = 0; j < part.indices.length; j += 3) {
    const ids = part.indices.slice(j, j + 3), abc = ids.map(id => part.points[id]);
    for (const sample of faceSamples(...abc)) {
      const q = anchored.query(sample);
      if (!q || q.depth <= CONTACT_TOLERANCE) continue;
      for (const id of ids) {
        if (protectedBody[i][id]) continue;
        const point = part.points[id], center = reference.centerAt(point.y);
        if (!center) continue;
        const direction = point.clone().sub(center); direction.y = 0;
        const radius = direction.length(); direction.normalize();
        const movement = Math.min(q.depth + FIT_MARGIN, Math.max(0, radius - FIT_MARGIN));
        const previous = proposals.get(point);
        if (!previous || previous.movement < movement) proposals.set(point, { direction, movement });
      }
    }
  }
  for (const [point, proposal] of proposals) point.addScaledVector(proposal.direction, -proposal.movement);
  writeFittedParts(body);
}

/** First-interval torso fitting and local contact separation share one immutable protection mask. */
export function fitContactClearance(garment, body) {
  const before = snapshotSurfaces(garment, body);
  const referenceBody = combinedSurface(body);
  const reference = createCoverage(combinedSurface(garment), referenceBody);
  const protectedBody = body.map(part => part.points.map(point => !reference.query(point)));
  before.protectedBody = protectedBody;
  const torso = fitCoveredTorso(garment, body);
  writeFittedParts(body);
  const result = fitSmoothGarment(garment, body, {}, {
    reference, referenceBody, protectedBody,
    update: (shell, mannequin, original) => followCoveredTorso(shell, mannequin, original, protectedBody),
  });
  createCoverage(combinedSurface(garment), referenceBody);
  result.shape = validateSurfaceShape(garment, body, before);
  assertNoSurfaceIntersections(garment);
  return { ...result, shapeReference: before, fittedSurfaces: snapshotSurfaces(garment, body),
    torsoMovedVertices: torso.movedVertices };
}
