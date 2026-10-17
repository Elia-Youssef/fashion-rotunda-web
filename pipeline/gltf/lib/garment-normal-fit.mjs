// Normal-guided fitting supports layered clothing without assuming a closed radial shell.
import { Matrix3, Matrix4, Vector3 } from 'three';
import { faceSamples, SEAM_TOLERANCE, surfaceParts } from './garment-coverage.mjs';
import { measureNormalVertices } from './garment-measurement.mjs';
import { writeFittedParts } from './garment-attributes.mjs';

const key = point => point.toArray().map(value => Math.round(value / SEAM_TOLERANCE)).join(',');

function vertexNormals(parts) {
  const result = new Map();
  for (const part of parts) {
    const attribute = part.primitive.getAttribute('NORMAL');
    if (!attribute) throw new Error('Normal fitting requires mannequin normals');
    const matrix = new Matrix3().getNormalMatrix(part.matrix);
    part.points.forEach((point, i) => {
      const k = key(point), sum = result.get(k) ?? new Vector3();
      sum.add(new Vector3().fromArray(attribute.getElement(i, [])).applyMatrix3(matrix).normalize());
      result.set(k, sum);
    });
  }
  for (const normal of result.values()) normal.normalize();
  return result;
}

/** Every shared probe retains all incident faces, including UV seam copies. */
export function measureNormalFaces(garment, body) {
  const normals = vertexNormals(body), probes = new Map(), owners = new Map();
  for (const part of body) for (let i = 0; i < part.indices.length; i += 3) {
    const abc = part.indices.slice(i, i + 3).map(j => part.points[j]);
    const ns = abc.map(point => normals.get(key(point)));
    const interpolated = [...ns, ns[0].clone().add(ns[1]), ns[1].clone().add(ns[2]),
      ns[2].clone().add(ns[0]), ns[0].clone().add(ns[1]).add(ns[2])];
    faceSamples(...abc).forEach((point, j) => {
      const k = key(point);
      if (!probes.has(k)) probes.set(k, { point, normal: interpolated[j].normalize() });
      const vertices = owners.get(k) ?? new Set();
      for (const corner of abc) vertices.add(key(corner));
      owners.set(k, vertices);
    });
  }
  const values = [...probes.values()];
  const sampled = [{ points: values.map(value => value.point), indices: [], matrix: new Matrix4(),
    primitive: { getAttribute: name => name === 'NORMAL'
      ? { getElement: (i, out) => values[i].normal.toArray(out) } : null } }];
  return { measurement: measureNormalVertices(garment, sampled, body), owners, normals };
}

/** Re-probe after each pass; failure never returns a partially fitted surface. */
export function fitNormalInward(document, policy) {
  const garment = surfaceParts(document, policy.garmentGroup);
  const initial = surfaceParts(document, policy.bodyGroup).map(part => part.points.map(point => point.clone()));
  const history = [];
  let converged = false;
  for (let pass = 0; pass <= policy.maxPasses; pass++) {
    const body = surfaceParts(document, policy.bodyGroup);
    const { measurement, owners, normals } = measureNormalFaces(garment, body);
    const outside = measurement.samples.filter(sample => sample.outside);
    // Contact tolerance is a diagnostic threshold, not safe clearance for visible surfaces.
    // Near-contact faces need the same correction before independent position quantization.
    const contacts = policy.minimumClearance === undefined ? outside
      : measurement.samples.filter(sample => sample.depthMm > -policy.minimumClearance * 1000);
    history.push({ pass, outsideProbes: outside.length,
      clearanceProbes: contacts.length,
      maxDepthMm: outside.reduce((max, sample) => Math.max(max, sample.depthMm), 0) });
    if (contacts.length === 0) { converged = true; break; }
    if (pass === policy.maxPasses) break;
    const proposals = new Map();
    for (const sample of contacts) {
      const distance = sample.depthMm / 1000 + policy.clearance;
      for (const vertex of owners.get(key(new Vector3().fromArray(sample.point)))) {
        proposals.set(vertex, Math.max(proposals.get(vertex) ?? 0, distance));
      }
    }
    for (const part of body) for (const point of part.points) {
      const k = key(point), distance = proposals.get(k);
      if (distance !== undefined) point.addScaledVector(normals.get(k), -distance);
    }
    writeFittedParts(body);
  }
  if (!converged) throw new Error(`Normal fit did not converge: ${JSON.stringify(history)}`);
  const body = surfaceParts(document, policy.bodyGroup);
  let movedVertices = 0, maxDisplacementMm = 0, maxExtraMm = 0;
  for (const [p, part] of body.entries()) for (const [i, point] of part.points.entries()) {
    const delta = point.clone().sub(initial[p][i]);
    if (delta.lengthSq() === 0) continue;
    movedVertices++;
    maxExtraMm = Math.max(maxExtraMm, delta.length() * policy.extraFraction * 1000);
    point.addScaledVector(delta, policy.extraFraction);
    maxDisplacementMm = Math.max(maxDisplacementMm, point.distanceTo(initial[p][i]) * 1000);
  }
  writeFittedParts(body);
  return { history, movedVertices, maxDisplacementMm, maxExtraMm, extraFraction: policy.extraFraction };
}
