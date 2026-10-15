// Test actual non-adjacent surface intersections independently of a face's rotation in space.
import { Matrix4 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { combinedSurface, surfaceTopology } from './garment-coverage.mjs';

export function findSurfaceIntersection(parts) {
  const geometry = combinedSurface(parts), topology = surfaceTopology(geometry);
  const first = new MeshBVH(geometry, { indirect: true });
  const second = new MeshBVH(geometry.clone(), { indirect: true });
  let found = null;
  first.bvhcast(second, new Matrix4(), {
    intersectsTriangles(a, b, i, j) {
      i = first.resolveTriangleIndex(i); j = second.resolveTriangleIndex(j);
      if (i >= j || topology.triangles[i].some(id => topology.triangles[j].includes(id))) return false;
      if (!a.intersectsTriangle(b, null, true)) return false;
      found = { first: i, second: j };
      return true;
    },
  });
  return found;
}

export function assertNoSurfaceIntersections(parts) {
  const found = findSurfaceIntersection(parts);
  if (found) throw new Error(`Garment self-intersection between faces ${found.first} and ${found.second}`);
}
