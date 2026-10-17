// CPU visibility comparison. Both looks use the same pixel-centre rays in look space.
import { DoubleSide, FrontSide, PerspectiveCamera, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { combinedSurface } from './garment-coverage.mjs';

export function surfaceRaycaster(parts, doubleSided = false) {
  const trees = parts.map(part => ({
    tree: new MeshBVH(combinedSurface([part]), { indirect: true }),
    side: doubleSided || part.primitive?.getMaterial()?.getDoubleSided() ? DoubleSide : FrontSide,
  }));
  return ray => {
    let closest = null;
    for (const { tree, side } of trees) {
      const hit = tree.raycastFirst(ray, side);
      if (hit && (!closest || hit.distance < closest.distance)) closest = hit;
    }
    return closest;
  };
}

/** Counts candidate body hits where the reference look first presents fabric, retaining 3D hits. */
export function compareGarmentViews(reference, candidate, view, width, height) {
  const camera = new PerspectiveCamera(view.fov, width / height, 0.001, 1000);
  camera.position.fromArray(view.position);
  camera.lookAt(new Vector3().fromArray(view.target));
  camera.updateMatrixWorld();
  const refGarment = surfaceRaycaster(reference.garment), refBody = surfaceRaycaster(reference.body);
  const garment = surfaceRaycaster(candidate.garment), body = surfaceRaycaster(candidate.body);
  const bothSides = surfaceRaycaster(candidate.garment, true);
  const samples = [];
  let referenceGarmentPixels = 0;
  const ray = new Ray(camera.position.clone());
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    ray.direction.set(2 * (x + 0.5) / width - 1, 1 - 2 * (y + 0.5) / height, 0.5)
      .unproject(camera).sub(camera.position).normalize();
    const rg = refGarment(ray);
    if (!rg) continue;
    const rb = refBody(ray);
    if (rb && rb.distance < rg.distance) continue;
    referenceGarmentPixels++;
    const cb = body(ray);
    if (!cb) continue;
    const cg = garment(ray);
    if (cg && cg.distance <= cb.distance) continue;
    const double = bothSides(ray);
    samples.push({ pixel: [x, y], bodyPoint: cb.point.toArray(), referencePoint: rg.point.toArray(),
      garmentPoint: cg?.point.toArray() ?? null,
      gapMm: cg ? (cg.distance - cb.distance) * 1000 : null,
      backfaceOnly: !!double && double.distance <= cb.distance,
      bodyFace: cb.faceIndex, referenceFace: rg.faceIndex });
  }
  return { width, height, referenceGarmentPixels, exposedBodyPixels: samples.length, samples };
}
