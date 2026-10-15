// Read-only vertex probes for open, layered or non-manifold garments. This diagnostic never
// grants permission to fit a mesh: fitting retains its independent topology admission check.
import { DoubleSide, Matrix3, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { combinedSurface, CONTACT_TOLERANCE, SEAM_TOLERANCE } from './garment-coverage.mjs';

/** Ten-centimetre bands match the coverage report's height rows, in scene-space metres. */
export const HEIGHT_BAND = 0.1;

/**
 * Coverage uses the garment's horizontal section extent centre at the vertex height. A ray
 * must meet the garment, and the vertex must belong to the first body interval or an interval
 * inside or crossing that garment hit. Separate limbs wholly beyond the shell are excluded.
 * Triangle-plane intersections define the extent without requiring manifold edges or closure.
 */
export function createVertexCoverage(garmentParts, bodyParts) {
  const geometry = combinedSurface(garmentParts), bodyGeometry = combinedSurface(bodyParts);
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox, sections = new Map();
  const garment = new MeshBVH(geometry, { indirect: true }), body = new MeshBVH(bodyGeometry, { indirect: true });
  function section(y) {
    if (sections.has(y)) return sections.get(y);
    const extent = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    garment.shapecast({
      intersectsBounds: box => y >= box.min.y && y <= box.max.y,
      intersectsTriangle: triangle => {
        const points = [triangle.a, triangle.b, triangle.c];
        for (let i = 0; i < 3; i++) {
          const a = points[i], b = points[(i + 1) % 3];
          if (y < Math.min(a.y, b.y) || y > Math.max(a.y, b.y)) continue;
          const f = a.y === b.y ? 0 : (y - a.y) / (b.y - a.y);
          const x = a.x + f * (b.x - a.x), z = a.z + f * (b.z - a.z);
          extent.minX = Math.min(extent.minX, x); extent.maxX = Math.max(extent.maxX, x);
          extent.minZ = Math.min(extent.minZ, z); extent.maxZ = Math.max(extent.maxZ, z);
        }
        return false;
      },
    });
    sections.set(y, extent); return extent;
  }
  function query(point) {
    if (point.y < bounds.min.y || point.y > bounds.max.y) return null;
    const extent = section(point.y);
    if (!Number.isFinite(extent.minX)) return null;
    const center = new Vector3((extent.minX + extent.maxX) / 2, point.y, (extent.minZ + extent.maxZ) / 2);
    const direction = point.clone().sub(center); direction.y = 0;
    const radius = direction.length(); if (radius <= CONTACT_TOLERANCE) return null;
    direction.divideScalar(radius);
    const ray = new Ray(center, direction), shell = garment.raycastFirst(ray, DoubleSide);
    if (!shell || shell.face.normal.dot(direction) <= 0) return null;
    const hits = body.raycast(ray, DoubleSide).sort((a, b) => a.distance - b.distance);
    const first = hits.find(hit => hit.face.normal.dot(direction) > 0);
    if (!first) return null;
    let covered = false, entry = 0;
    for (const hit of hits) {
      if (hit.face.normal.dot(direction) < 0) entry = hit.distance;
      else if (entry <= shell.distance &&
        radius >= entry - CONTACT_TOLERANCE && radius <= hit.distance + CONTACT_TOLERANCE) covered = true;
    }
    const reach = Math.hypot(extent.maxX - extent.minX, extent.maxZ - extent.minZ) / 2;
    return covered ? { center, direction, reach } : null;
  }
  return { query, garment };
}

/** Casts both normal directions, retaining the nearest same-facing shell surface and signed depth. */
export function measureNormalVertices(garmentParts, bodyParts, referenceBodyParts = bodyParts) {
  const coverage = createVertexCoverage(garmentParts, referenceBodyParts), vertices = new Map();
  for (const part of bodyParts) {
    const normals = part.primitive?.getAttribute('NORMAL');
    if (!normals) throw new Error('Normal measurement requires authored mannequin normals');
    const normalMatrix = new Matrix3().getNormalMatrix(part.matrix);
    for (let i = 0; i < part.points.length; i++) {
      const point = part.points[i], key = point.toArray().map(v => Math.round(v / SEAM_TOLERANCE)).join(',');
      const value = vertices.get(key) ?? { point, normal: new Vector3() };
      value.normal.add(new Vector3().fromArray(normals.getElement(i, [])).applyMatrix3(normalMatrix).normalize());
      vertices.set(key, value);
    }
  }
  const samples = [], bands = {};
  let coveredVertices = 0, unprobedVertices = 0;
  for (const { point, normal } of vertices.values()) {
    const covered = coverage.query(point); if (!covered) continue;
    coveredVertices++;
    normal.normalize();
    // A probe must hit the local garment side first. Looking through an opposite-facing hit
    // or up to a remote neckline would mistake an exposed sole or opening for penetration.
    const nearest = (direction) => {
      const hit = coverage.garment.raycastFirst(new Ray(point, direction), DoubleSide);
      if (!hit || hit.face.normal.dot(normal) <= 0 || hit.distance > covered.reach ||
        Math.abs(hit.point.y - point.y) > HEIGHT_BAND ||
        hit.point.clone().sub(covered.center).dot(covered.direction) <= 0) return null;
      return hit;
    };
    const inward = nearest(normal.clone().negate()), outward = nearest(normal);
    if (!inward && !outward) { unprobedVertices++; continue; }
    const depth = inward && (!outward || inward.distance < outward.distance) ? inward.distance : -outward.distance;
    const band = (Math.floor(point.y / HEIGHT_BAND) * HEIGHT_BAND).toFixed(1);
    bands[band] ??= { covered: 0, outside: 0, depthsMm: [] };
    bands[band].covered++;
    const outside = depth > CONTACT_TOLERANCE;
    if (outside) { bands[band].outside++; bands[band].depthsMm.push(depth * 1000); }
    samples.push({ point: point.toArray(), normal: normal.toArray(), depthMm: depth * 1000, outside,
      inwardMm: inward ? inward.distance * 1000 : null, outwardMm: outward ? outward.distance * 1000 : null });
  }
  return { uniqueVertices: vertices.size, coveredVertices, unprobedVertices,
    outsideVertices: samples.filter(sample => sample.outside).length, samples, bands };
}
