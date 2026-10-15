import { Document, NodeIO } from '@gltf-transform/core';
import { BufferGeometry, CylinderGeometry, SphereGeometry, Vector3 } from 'three';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { describe, expect, it } from 'vitest';
import { combinedSurface, createCoverage, measureSurface, surfaceParts } from '../../pipeline/gltf/lib/garment-coverage.mjs';
import { applyLookFit, fitCoveredSurface, LOOK_FIT_POLICIES, validateFitOutput } from '../../pipeline/gltf/lib/garment-fit.mjs';
import { assertNoSurfaceIntersections } from '../../pipeline/gltf/lib/garment-intersection.mjs';
import { measureNormalVertices } from '../../pipeline/gltf/lib/garment-measurement.mjs';
import {
  constrainGarmentFalloff, fitSmoothGarment, MAX_GARMENT_DISPLACEMENT, MAX_GARMENT_EDGE_RATIO,
  snapshotSurfaces, validateSurfaceShape,
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

/** A garment group and a mannequin group with authored normals, the shape the solver reads. */
function normalDocument(garment: BufferGeometry, body: BufferGeometry[]) {
  const doc = new Document(), buffer = doc.createBuffer(), scene = doc.createScene();
  for (const [name, geometries] of [['garment', [garment]], ['mannequin', body]] as const) {
    const group = doc.createNode(name); scene.addChild(group);
    for (const geometry of geometries) {
      const primitive = doc.createPrimitive();
      for (const [attribute, field] of [['POSITION', 'position'], ['NORMAL', 'normal']] as const) {
        primitive.setAttribute(attribute, doc.createAccessor().setType('VEC3').setBuffer(buffer)
          .setArray(new Float32Array(geometry.getAttribute(field).array)));
      }
      primitive.setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buffer)
        .setArray(new Uint32Array(geometry.getIndex()!.array)));
      group.addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)));
    }
  }
  return doc;
}

describe('shape-preserving fit refusals', () => {
  it('rejects a contact probe when the filtered body surface is empty', () => {
    // The mannequin surrounds the shell, so every vertex is covered and none is protected:
    // the protected-vertex contact body contains no triangle for the closest-point query.
    const doc = normalDocument(new CylinderGeometry(0.1, 0.1, 0.4, 24, 4, true),
      [new CylinderGeometry(0.2, 0.2, 0.3, 16, 4)]);
    const garment = surfaceParts(doc, 'garment'), body = surfaceParts(doc, 'mannequin');
    const protectedBody = body.map(part => part.points.map(() => false));
    const adjustment = {
      reference: createCoverage(combinedSurface(garment), combinedSurface(body)),
      referenceBody: combinedSurface(body),
      protectedBody,
      update: () => {},
    };
    expect(() => fitSmoothGarment(garment, body, {}, adjustment))
      .toThrow('Body contact has no nearest surface');
  });

  it('rejects a topology or opening change even when positions are untouched', () => {
    const { garment, body } = fixture(), before = snapshotSurfaces(garment, body);
    const indices = garment[0].indices;
    [indices[0], indices[1]] = [indices[1], indices[0]];
    expect(() => validateSurfaceShape(garment, body, before))
      .toThrow('Garment fitting changed topology or openings');
  });

  it('rejects a face collapsed onto its own edge', () => {
    const { garment, body } = fixture(), before = snapshotSurfaces(garment, body);
    const [a, b, c] = garment[0].indices.slice(0, 3);
    garment[0].points[c].copy(garment[0].points[a].clone().lerp(garment[0].points[b], 0.5));
    expect(() => validateSurfaceShape(garment, body, before)).toThrow('Garment fitting collapsed a face');
  });

  it('refuses falloff offsets that cannot satisfy a pinned edge', () => {
    // Both endpoints are pinned at their original places, two units apart along an edge whose
    // gradient bound is 47.5 percent: no projection can ever satisfy it.
    const points = [new Vector3(0, 0, 0), new Vector3(2, 0, 0)];
    const neighbors = [new Map([[1, 1]]), new Map([[0, 1]])];
    expect(() => constrainGarmentFalloff([new Vector3(), new Vector3()], neighbors, points, new Set([0, 1])))
      .toThrow('Garment falloff did not meet the edge gradient bound');
  });

  it('refuses a smooth fit whose every shell vertex is pinned at the openings', () => {
    // A one-ring shell pins all of its vertices at the two opening loops, so the falloff
    // constraint zeroes every offset: the two-millimetre poke can never be cleared.
    const doc = normalDocument(new CylinderGeometry(0.1, 0.1, 0.4, 24, 1, true),
      [new CylinderGeometry(0.075, 0.075, 0.3, 16, 4)]);
    const garment = surfaceParts(doc, 'garment'), body = surfaceParts(doc, 'mannequin');
    const poke = body[0].points.findIndex(point => point.y === 0 && point.z > 0.07 && point.x === 0);
    body[0].points[poke].set(0, 0, 0.102);
    expect(() => fitSmoothGarment(garment, body))
      .toThrow('Smooth garment fitting did not converge');
  });

  it('rejects a serialized contact fit whose mannequin pokes back through the shell', () => {
    const { doc } = fixture();
    const fit = applyLookFit(doc, 'mondrian-dress');
    expect(validateFitOutput(doc, fit)).toMatchObject({ checked: true });
    const torso = surfaceParts(doc, 'mannequin')[0];
    const positions = torso.primitive.getAttribute('POSITION')!;
    const index = torso.points.findIndex(point => point.x < -0.05);
    const [x = 0, y = 0, z = 0] = positions.getElement(index, [0, 0, 0]);
    positions.setElement(index, [x * 1.8, y, z * 1.8]);
    expect(() => validateFitOutput(doc, fit)).toThrow(/Serialized garment fit failed: \d+ outside vertices/);
  });
});
