// Offline coverage queries for an open garment around a body. Rays start at the garment's
// horizontal section centre, rather than its pivot. Only the first body interval belongs to
// the covered torso or legs: a separate hand or arm farther along a ray remains exposed.
import {
  BufferGeometry, DoubleSide, Float32BufferAttribute, Line3, Matrix4, Ray, Vector3,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';

/** One micrometre welds exported seams without collapsing distinct garment edges. */
export const SEAM_TOLERANCE = 0.000001;
/** A tenth of a millimetre separates numerical contact from a visible penetration. */
export const CONTACT_TOLERANCE = 0.0001;
/** One millimetre leaves room for meshopt position quantization after fitting. */
export const FIT_MARGIN = 0.001;
/** A two millimetre strip below an opening preserves its visible interior. */
export const OPENING_GUARD = 0.002;

/** Extracts triangle data in scene space; attributes and variants stay on the original primitive. */
export function surfaceParts(document, groupName) {
  const result = [];
  for (const scene of document.getRoot().listScenes()) {
    for (const group of scene.listChildren()) {
      if (group.getName() !== groupName) continue;
      group.traverse((node) => {
        if (!node.getMesh()) return;
        const matrix = new Matrix4().fromArray(node.getWorldMatrix());
        for (const primitive of node.getMesh().listPrimitives()) {
          if (primitive.getMode() !== 4) throw new Error('Garment coverage requires triangle primitives');
          const positions = primitive.getAttribute('POSITION');
          if (!positions || primitive.listTargets().length || node.getSkin()) {
            throw new Error('Garment coverage requires static position geometry');
          }
          const points = [];
          for (let i = 0; i < positions.getCount(); i++) {
            points.push(new Vector3().fromArray(positions.getElement(i, [])).applyMatrix4(matrix));
          }
          const indices = primitive.getIndices();
          result.push({ primitive, matrix, points, indices: indices ? [...indices.getArray()] : points.map((_, i) => i) });
        }
      });
    }
  }
  if (result.length === 0) throw new Error(`Missing surface group ${groupName}`);
  return result;
}

/** A geometry-only view for BVH queries. The source indices are never reordered. */
export function combinedSurface(parts) {
  const positions = [], indices = [];
  for (const part of parts) {
    const offset = positions.length / 3;
    for (const point of part.points) positions.push(...point.toArray());
    for (const i of part.indices) indices.push(i + offset);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

/** Weld by position only for topology, leaving UV and normal seams in the emitted mesh untouched. */
export function surfaceTopology(geometry) {
  const position = geometry.getAttribute('position'), index = geometry.getIndex();
  const points = [], ids = [], byPosition = new Map(), edges = new Map();
  for (let i = 0; i < position.count; i++) {
    const p = new Vector3().fromBufferAttribute(position, i);
    const key = p.toArray().map((v) => Math.round(v / SEAM_TOLERANCE)).join(',');
    if (!byPosition.has(key)) { byPosition.set(key, points.length); points.push(p); }
    ids.push(byPosition.get(key));
  }
  let degenerateFaces = 0;
  const triangles = [];
  for (let i = 0; i < index.count; i += 3) {
    const abc = [0, 1, 2].map((j) => ids[index.getX(i + j)]);
    triangles.push(abc);
    const [a, b, c] = abc.map((j) => points[j]);
    if (new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).length() <= SEAM_TOLERANCE ** 2) {
      degenerateFaces++;
    }
    for (let j = 0; j < 3; j++) {
      const a = abc[j], b = abc[(j + 1) % 3];
      const key = `${Math.min(a, b)},${Math.max(a, b)}`;
      const edge = edges.get(key) ?? { a, b, directions: [] };
      edge.directions.push(a < b ? 1 : -1);
      edges.set(key, edge);
    }
  }
  const boundary = [...edges.values()].filter((e) => e.directions.length === 1);
  const neighbors = new Map();
  for (const { a, b } of boundary) {
    for (const [from, to] of [[a, b], [b, a]]) {
      const list = neighbors.get(from) ?? []; list.push(to); neighbors.set(from, list);
    }
  }
  const seen = new Set(), loops = [];
  for (const start of neighbors.keys()) {
    if (seen.has(start)) continue;
    const queue = [start], vertices = [];
    while (queue.length) {
      const v = queue.pop();
      if (seen.has(v)) continue;
      seen.add(v); vertices.push(v); queue.push(...neighbors.get(v));
    }
    loops.push({ vertices, closed: vertices.every((v) => neighbors.get(v).length === 2),
      min: [0, 1, 2].map((j) => Math.min(...vertices.map((v) => points[v].getComponent(j)))),
      max: [0, 1, 2].map((j) => Math.max(...vertices.map((v) => points[v].getComponent(j)))) });
  }
  return {
    points, triangles, boundary: boundary.map(({ a, b }) => new Line3(points[a], points[b])), loops,
    degenerateFaces,
    nonManifoldEdges: [...edges.values()].filter((e) => e.directions.length > 2).length,
    inconsistentEdges: [...edges.values()].filter((e) => e.directions.length === 2 && e.directions[0] === e.directions[1]).length,
  };
}

function sectionCenters(topology) {
  const heights = [...new Set(topology.points.map((p) => p.y))].sort((a, b) => a - b);
  return heights.map((y) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const triangle of topology.triangles) {
      for (let i = 0; i < 3; i++) {
        const a = topology.points[triangle[i]], b = topology.points[triangle[(i + 1) % 3]];
        if (y < Math.min(a.y, b.y) || y > Math.max(a.y, b.y)) continue;
        const f = a.y === b.y ? 0 : (y - a.y) / (b.y - a.y);
        const x = a.x + f * (b.x - a.x), z = a.z + f * (b.z - a.z);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
    }
    return new Vector3((minX + maxX) / 2, y, (minZ + maxZ) / 2);
  });
}

/** Uses the unchanged body as a coverage reference, including when testing a repaired body. */
export function createCoverage(garmentGeometry, bodyGeometry, reference = null) {
  const topology = surfaceTopology(garmentGeometry);
  if (topology.degenerateFaces || topology.nonManifoldEdges || topology.inconsistentEdges ||
      topology.loops.some((loop) => !loop.closed)) {
    throw new Error('Garment shell has invalid topology; coverage repair refused');
  }
  const centers = sectionCenters(topology);
  const garment = new MeshBVH(garmentGeometry, { indirect: true });
  const body = new MeshBVH(bodyGeometry, { indirect: true });
  function centerAt(y) {
    if (y < centers[0].y || y > centers.at(-1).y) return null;
    let low = 0, high = centers.length - 1;
    while (high - low > 1) { const mid = (low + high) >> 1; if (centers[mid].y <= y) low = mid; else high = mid; }
    const a = centers[low], b = centers[high];
    return a.clone().lerp(b, (y - a.y) / (b.y - a.y));
  }
  function query(point) {
    if (reference) {
      const base = reference.query(point);
      if (!base) return null;
      const hit = garment.raycastFirst(new Ray(base.center, base.direction), DoubleSide);
      if (!hit) throw new Error(`Fitting opened a previously covered garment direction at ${point.toArray()}`);
      return { ...base, shellRadius: hit.distance, depth: base.radius - hit.distance,
        point: hit.point, faceIndex: hit.faceIndex };
    }
    const center = centerAt(point.y);
    if (!center) return null;
    const direction = point.clone().sub(center); direction.y = 0;
    const radius = direction.length();
    if (radius <= CONTACT_TOLERANCE) return null;
    direction.divideScalar(radius);
    const ray = new Ray(center, direction);
    // A ray through an armhole has no garment exit and must never classify the exposed arm.
    const hit = garment.raycastFirst(ray, DoubleSide);
    if (!hit || hit.face.normal.dot(direction) <= 0) return null;
    const bodyHits = body.raycast(ray, DoubleSide).sort((a, b) => a.distance - b.distance);
    const firstExit = bodyHits.find((h) => h.face.normal.dot(direction) > 0);
    if (!firstExit || radius > firstExit.distance + CONTACT_TOLERANCE) return null;
    let openingDistance = Infinity;
    const closest = new Vector3();
    for (const edge of topology.boundary) {
      openingDistance = Math.min(openingDistance, edge.closestPointToPoint(hit.point, true, closest).distanceTo(hit.point));
    }
    return { center, direction, radius, shellRadius: hit.distance,
      depth: radius - hit.distance, openingDistance, point: hit.point, faceIndex: hit.faceIndex };
  }
  return { query, topology, centerAt };
}

/** Vertices, edge midpoints and centroid sample the actual triangle surface, not only labels. */
export function faceSamples(a, b, c) {
  return [a, b, c, a.clone().lerp(b, 0.5), b.clone().lerp(c, 0.5), c.clone().lerp(a, 0.5),
    a.clone().add(b).add(c).divideScalar(3)];
}

/** Raw depths and positions are retained so percentile summaries can be independently reproduced. */
export function measureSurface(parts, coverage) {
  const unique = new Map(), penetrations = [], bands = {};
  let totalFaces = 0, penetratingFaces = 0, coveredSamples = 0;
  for (const part of parts) {
    for (let i = 0; i < part.indices.length; i += 3) {
      totalFaces++;
      const abc = part.indices.slice(i, i + 3).map((j) => part.points[j]);
      let penetrating = false;
      for (const point of faceSamples(...abc)) {
        const key = point.toArray().join(',');
        let q = unique.get(key);
        if (q === undefined) {
          q = coverage.query(point); unique.set(key, q);
          if (q) {
            coveredSamples++;
            const band = (Math.floor(point.y * 10) / 10).toFixed(1);
            bands[band] ??= { covered: 0, outside: 0, depthsMm: [] };
            bands[band].covered++;
            if (q.depth > CONTACT_TOLERANCE) {
              const sample = { point: point.toArray(), depthMm: q.depth * 1000, openingDistanceMm: q.openingDistance * 1000 };
              penetrations.push(sample); bands[band].outside++; bands[band].depthsMm.push(sample.depthMm);
            }
          }
        }
        if (q && q.depth > CONTACT_TOLERANCE) penetrating = true;
      }
      if (penetrating) penetratingFaces++;
    }
  }
  return { totalFaces, penetratingFaces, uniqueSamples: unique.size, coveredSamples, outsideSamples: penetrations.length, bands, penetrations };
}
