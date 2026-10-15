import { Document, NodeIO } from '@gltf-transform/core';
import { BufferGeometry, CylinderGeometry, SphereGeometry, Vector3 } from 'three';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { describe, expect, it } from 'vitest';
import { combinedSurface, createCoverage, measureSurface, surfaceParts } from '../../pipeline/gltf/lib/garment-coverage.mjs';
import { applyLookFit, fitCoveredSurface, LOOK_FIT_POLICIES } from '../../pipeline/gltf/lib/garment-fit.mjs';
import { assertNoSurfaceIntersections } from '../../pipeline/gltf/lib/garment-intersection.mjs';
import { measureNormalVertices } from '../../pipeline/gltf/lib/garment-measurement.mjs';
import {
  fitSmoothGarment, MAX_GARMENT_DISPLACEMENT, MAX_GARMENT_EDGE_RATIO, snapshotSurfaces, validateSurfaceShape,
} from '../../pipeline/gltf/lib/garment-shape.mjs';

function fixture() {
  const doc = new Document(), buffer = doc.createBuffer(), scene = doc.createScene();
  function group(name: string, geometries: BufferGeometry[]) {
    const group = doc.createNode(name); scene.addChild(group);
    for (const geometry of geometries) {
      const primitive = doc.createPrimitive();
      for (const [field, attribute] of [['POSITION', 'position'], ['NORMAL', 'normal']] as const) {
        primitive.setAttribute(field, doc.createAccessor().setType('VEC3').setBuffer(buffer)
          .setArray(new Float32Array(geometry.getAttribute(attribute).array)));
      }
      primitive.setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buffer)
        .setArray(new Uint32Array(geometry.getIndex()!.array)));
      group.addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)));
    }
  }
  group('garment', [new CylinderGeometry(0.1, 0.1, 0.4, 96, 16, true)]);
  group('mannequin', [new CylinderGeometry(0.075, 0.075, 0.3, 32, 12),
    new SphereGeometry(0.015, 16, 12).translate(0.105, 0, 0)]);
  return { doc, garment: surfaceParts(doc, 'garment'), body: surfaceParts(doc, 'mannequin') };
}

describe('shape-preserving garment fitting', () => {
  it('keeps every covered and exposed body vertex exact while fitting a crossing limb', () => {
    const { garment, body } = fixture(), before = snapshotSurfaces(garment, body);
    const torso = createCoverage(combinedSurface(garment), combinedSurface(body));
    expect(body[1].points.some(point => torso.query(point) === null)).toBe(true);
    const fit = fitSmoothGarment(garment, body);
    expect(body.map(part => part.points.map(point => point.toArray())))
      .toEqual(before.body.map(part => part.points.map(point => point.toArray())));
    expect(fit.shape.protectedBodyVerticesMoved).toBe(0);
    expect(measureSurface(body, createCoverage(combinedSurface(garment), fit.referenceBody)).outsideSamples).toBe(0);
    expect(measureNormalVertices(garment, body).outsideVertices).toBe(0);
  });

  it('bounds every displacement and edge change without removing faces or openings', () => {
    const { garment, body } = fixture(), before = snapshotSurfaces(garment, body);
    fitSmoothGarment(garment, body);
    const shape = validateSurfaceShape(garment, body, before);
    expect(shape.maxDisplacementMm).toBeGreaterThan(0);
    expect(shape.maxDisplacementMm).toBeLessThanOrEqual(MAX_GARMENT_DISPLACEMENT * 1000);
    expect(shape.maxEdgeRatio).toBeLessThanOrEqual(MAX_GARMENT_EDGE_RATIO);
    expect(garment.map(part => part.indices)).toEqual(before.garment.map(part => part.indices));
  });

  it('rejects inward limb fitting even when it eliminates penetration', () => {
    const { garment, body } = fixture(), before = snapshotSurfaces(garment, body);
    const original = createCoverage(combinedSurface(garment), combinedSurface(body));
    before.protectedBody = body.map(part => part.points.map(point => !original.query(point)));
    fitCoveredSurface(garment, body, 'body-inward', { includeIntersectingIntervals: true });
    expect(() => validateSurfaceShape(garment, body, before)).toThrow('Protected body vertex moved');
  });
  it('rejects the isolated contact spike produced without a falloff', () => {
    const { garment, body } = fixture(), before = snapshotSurfaces(garment, body);
    let nearest = garment[0].points[0];
    for (const point of garment[0].points) {
      if (Math.hypot(point.x - 0.1, point.y, point.z) < Math.hypot(nearest.x - 0.1, nearest.y, nearest.z)) nearest = point;
    }
    const original = nearest.clone();
    for (const point of garment[0].points) if (point.equals(original)) point.x += 0.02;
    expect(() => validateSurfaceShape(garment, body, before)).toThrow('Garment edge ratio bound exceeded');
  });

  it('rejects an excessive displacement even when every edge retains its length', () => {
    const { garment, body } = fixture(), before = snapshotSurfaces(garment, body);
    for (const part of garment) for (const point of part.points) point.x += MAX_GARMENT_DISPLACEMENT + 0.001;
    expect(() => validateSurfaceShape(garment, body, before)).toThrow('Garment displacement bound exceeded');
  });

  it('applies the contact policy without moving any vertex outside original torso intervals', () => {
    const { doc, garment, body } = fixture(), before = snapshotSurfaces(garment, body);
    const original = createCoverage(combinedSurface(garment), combinedSurface(body));
    const protectedBody = body.map(part => part.points.map(point => !original.query(point)));
    const fit = applyLookFit(doc, 'mondrian-dress');
    expect(fit).toMatchObject({ applied: true, method: 'contact-clearance' });
    const fittedBody = surfaceParts(doc, 'mannequin');
    for (const [i, part] of fittedBody.entries()) for (const [j, point] of part.points.entries()) {
      if (protectedBody[i][j]) expect(point.toArray()).toEqual(before.body[i].points[j].toArray());
    }
    expect(measureNormalVertices(surfaceParts(doc, 'garment'), surfaceParts(doc, 'mannequin')).outsideVertices).toBe(0);
  });

  it.each(['full', 'half'])('measures zero penetration in each shipped %s fitted look', async set => {
    await MeshoptDecoder.ready;
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    for (const [id, policy] of Object.entries(LOOK_FIT_POLICIES)) {
      const prefix = set === 'half' ? 'half/' : '';
      const doc = await io.read(`public/content/${prefix}looks/${id}.glb`);
      const measurement = measureNormalVertices(surfaceParts(doc, policy.garmentGroup), surfaceParts(doc, policy.bodyGroup));
      expect(measurement.coveredVertices).toBeGreaterThan(0);
      expect(measurement.outsideVertices).toBe(0);
      expect(() => assertNoSurfaceIntersections(surfaceParts(doc, policy.garmentGroup))).not.toThrow();
    }
  });

  it('rejects a surface crossing even when edge lengths and displacement stay inside their bounds', () => {
    const garment = [{ points: [
      new Vector3(-0.005, -0.005, 0), new Vector3(0.005, -0.005, 0), new Vector3(0, 0.005, 0),
      new Vector3(0.01, -0.003, -0.003), new Vector3(0.01, 0.003, -0.003), new Vector3(0.01, 0, 0.003),
    ], indices: [0, 1, 2, 3, 4, 5] }];
    const { body } = fixture(), before = snapshotSurfaces(garment, body);
    expect(() => assertNoSurfaceIntersections(garment)).not.toThrow();
    for (const point of garment[0].points.slice(3)) point.x -= 0.01;
    expect(() => validateSurfaceShape(garment, body, before)).not.toThrow();
    expect(() => assertNoSurfaceIntersections(garment)).toThrow('Garment self-intersection');
  });

});
