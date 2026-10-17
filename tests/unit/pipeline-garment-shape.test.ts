import { Document, NodeIO } from '@gltf-transform/core';
import { BufferGeometry, CylinderGeometry, DoubleSide, Float32BufferAttribute, Ray, SphereGeometry, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { describe, expect, it } from 'vitest';
import { combinedSurface, createCoverage, measureSurface, SEAM_TOLERANCE, surfaceParts } from '../../pipeline/gltf/lib/garment-coverage.mjs';
import { applyLookFit, fitCoveredSurface, LOOK_FIT_POLICIES, validateFitOutput } from '../../pipeline/gltf/lib/garment-fit.mjs';
import { assertNoSurfaceIntersections } from '../../pipeline/gltf/lib/garment-intersection.mjs';
import { measureNormalVertices } from '../../pipeline/gltf/lib/garment-measurement.mjs';
import {
  constrainGarmentFalloff, fitContactClearance, fitSmoothGarment, MAX_GARMENT_DISPLACEMENT,
  MAX_GARMENT_EDGE_RATIO, snapshotSurfaces, validateSurfaceShape,
} from '../../pipeline/gltf/lib/garment-shape.mjs';

// The two full contact fits below run the whole solver over the cylinder fixture: about 1.1 to 1.2 s
// each on the desktop (2026-10-15, under the 50 percent CPU cap), so the 5 s default has passed only
// under heavy parallel load. Their budget leaves that load room without hiding a real slowdown.
const HEAVY_FIT_TIMEOUT_MS = 20_000;

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

/** A garment and mannequin pair from authored geometries, several parts per group. */
function authoredPair(garments: BufferGeometry[], bodies: BufferGeometry[]) {
  const doc = new Document(), buffer = doc.createBuffer(), scene = doc.createScene();
  for (const [name, geometries] of [['garment', garments], ['mannequin', bodies]] as const) {
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
  return { doc, garment: surfaceParts(doc, 'garment'), body: surfaceParts(doc, 'mannequin') };
}

/** One authored triangle with a shared vertex normal. */
function triangleGeometry(a: number[], b: number[], c: number[], normal: number[]) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([...a, ...b, ...c], 3));
  geometry.setAttribute('normal', new Float32BufferAttribute([...normal, ...normal, ...normal], 3));
  geometry.setIndex([0, 1, 2]);
  return geometry;
}

function changedPoints(part: { points: Vector3[] }, beforePart: { points: Vector3[] }) {
  return part.points.filter((point, j) => !point.equals(beforePart.points[j])).length;
}

/** Displacements of every original vertex of one horizontal ring, matched by height.
 *  Positions round-trip through float32 accessors, so the ring match needs weld tolerance. */
function ringDisplacements(part: { points: Vector3[] }, beforePart: { points: Vector3[] }, y: number) {
  const result: number[] = [];
  for (const [j, point] of part.points.entries()) {
    if (Math.abs(beforePart.points[j].y - y) < SEAM_TOLERANCE) result.push(point.distanceTo(beforePart.points[j]));
  }
  return result;
}

const positionKey = (point: Vector3) => point.toArray().map(value => Math.round(value / SEAM_TOLERANCE)).join(',');

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
  }, HEAVY_FIT_TIMEOUT_MS);

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

  it('rejects a face whose normal falls under the collapse tolerance but stays nonzero', () => {
    // A one-square-micrometre face: its cross product (1e-12) sits exactly at the
    // SEAM_TOLERANCE squared threshold, above zero and below any visible collapse.
    const garment = [{ points: [
      new Vector3(0, 0, 0), new Vector3(0.000001, 0, 0), new Vector3(0, 0.000001, 0),
    ], indices: [0, 1, 2] }];
    const { body } = fixture(), before = snapshotSurfaces(garment, body);
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
  }, HEAVY_FIT_TIMEOUT_MS);
});

describe('shape validation bounds', () => {
  it('protects every body vertex when the snapshot carries no protection mask', () => {
    const { garment, body } = fixture(), before = snapshotSurfaces(garment, body);
    body[0].points[0].x += 0.001;
    expect(() => validateSurfaceShape(garment, body, before)).toThrow('Protected body vertex moved');
  });

  it('rejects a truncated index array as a topology change', () => {
    const { garment, body } = fixture(), before = snapshotSurfaces(garment, body);
    garment[0].indices.splice(-3);
    expect(() => validateSurfaceShape(garment, body, before))
      .toThrow('Garment fitting changed topology or openings');
  });

  it('excludes a sub-tolerance original edge from the ratio bound', () => {
    const garment = [{ points: [
      new Vector3(0, 0, 0), new Vector3(0.0000001, 0, 0), new Vector3(0, 1, 0),
    ], indices: [0, 1, 2] }];
    const { body } = fixture(), before = snapshotSurfaces(garment, body);
    garment[0].points[1].x += 0.0001;
    expect(() => validateSurfaceShape(garment, body, before)).not.toThrow();
  });

  it('rejects edge shrinkage through the two-sided ratio', () => {
    // A boundary fan whose every spoke shrinks: no edge stretches, only contracts.
    const garment = [{ points: [
      new Vector3(0, 0, 0), new Vector3(0.03, 0, 0), new Vector3(0.03, 0.01, 0), new Vector3(0.03, -0.01, 0),
    ], indices: [0, 1, 2, 0, 2, 3] }];
    const { body } = fixture(), before = snapshotSurfaces(garment, body);
    garment[0].points[0].set(0.02, 0, 0);
    expect(() => validateSurfaceShape(garment, body, before)).toThrow('Garment edge ratio bound exceeded');
  });

  it('accepts a displacement and edge ratio inside the published bounds', () => {
    const { garment, body } = fixture(), before = snapshotSurfaces(garment, body);
    const index = garment[0].points.reduce((best, point, j) =>
      point.distanceTo(new Vector3(0.1, 0, 0)) < garment[0].points[best].distanceTo(new Vector3(0.1, 0, 0)) ? j : best, 0);
    garment[0].points[index].y -= 0.005;
    const shape = validateSurfaceShape(garment, body, before);
    expect(shape.maxEdgeRatio).toBeGreaterThan(1.15);
    expect(shape.maxEdgeRatio).toBeLessThanOrEqual(MAX_GARMENT_EDGE_RATIO);
    expect(shape.maxDisplacementMm).toBeLessThanOrEqual(MAX_GARMENT_DISPLACEMENT * 1000);
  });

  it('rejects an edge ratio between the bound and twice it', () => {
    const { garment, body } = fixture(), before = snapshotSurfaces(garment, body);
    const index = garment[0].points.reduce((best, point, j) =>
      point.distanceTo(new Vector3(0.1, 0, 0)) < garment[0].points[best].distanceTo(new Vector3(0.1, 0, 0)) ? j : best, 0);
    garment[0].points[index].y -= 0.0075;
    expect(() => validateSurfaceShape(garment, body, before)).toThrow('Garment edge ratio bound exceeded');
  });
});

describe('falloff gradient projection', () => {
  /** Two unit-apart points joined by one edge, the whole graph the direct cases need. */
  function joinedPair(length = 1) {
    return {
      neighbors: [new Map<number, number>([[1, length]]), new Map<number, number>([[0, length]])],
      points: [new Vector3(0, 0, 0), new Vector3(length, 0, 0)],
    };
  }

  function edgeLength(points: Vector3[], offsets: Vector3[]) {
    return points[1].clone().add(offsets[1]).sub(points[0]).sub(offsets[0]).length();
  }

  it('restores an overstretched or compressed free edge to within the gradient bound', () => {
    const { neighbors, points } = joinedPair();
    const stretchedOffsets = [new Vector3(-0.24, 0, 0), new Vector3(0.24, 0, 0)];
    constrainGarmentFalloff(stretchedOffsets, neighbors, points);
    // The half-per-edge correction lands an overstretched edge exactly on the
    // bound; a full step per end overshoots into the band (1.47 here).
    expect(edgeLength(points, stretchedOffsets)).toBeGreaterThan(1.4745);
    expect(edgeLength(points, stretchedOffsets)).toBeLessThanOrEqual(1.4755);
    const compressedOffsets = [new Vector3(0.24, 0, 0), new Vector3(-0.24, 0, 0)];
    constrainGarmentFalloff(compressedOffsets, neighbors, points);
    expect(edgeLength(points, compressedOffsets)).toBeGreaterThanOrEqual(1 / 1.475 - 0.001);
    expect(edgeLength(points, compressedOffsets)).toBeLessThanOrEqual(1);
  });

  it('separates a collapsed edge along its base direction', () => {
    const { neighbors, points } = joinedPair(0.5);
    const offsets = [new Vector3(), new Vector3(-0.5, 0, 0)];
    constrainGarmentFalloff(offsets, neighbors, points);
    const separated = edgeLength(points, offsets);
    expect(separated).toBeGreaterThan(0.2);
    expect(separated).toBeLessThanOrEqual(0.34);
  });

  it('moves only the free end of a half-pinned edge, starting from a zero pinned offset', () => {
    const { neighbors, points } = joinedPair();
    const aPinned = [new Vector3(0.3, 0, 0), new Vector3(0.48, 0, 0)];
    constrainGarmentFalloff(aPinned, neighbors, points, new Set([0]));
    expect(aPinned[0].length()).toBe(0);
    expect(edgeLength(points, aPinned)).toBeGreaterThan(1.4);
    expect(edgeLength(points, aPinned)).toBeLessThanOrEqual(1.4755);
    const bPinned = [new Vector3(-0.48, 0, 0), new Vector3(0.3, 0, 0)];
    constrainGarmentFalloff(bPinned, neighbors, points, new Set([1]));
    expect(bPinned[1].length()).toBe(0);
    expect(edgeLength(points, bPinned)).toBeGreaterThan(1.4);
    expect(edgeLength(points, bPinned)).toBeLessThanOrEqual(1.4755);
  });

  it('relaxes a stretched chain within the bound on every edge', () => {
    const neighbors = [
      new Map([[1, 1]]), new Map([[0, 1], [2, 1]]), new Map([[1, 1], [3, 1]]), new Map([[2, 1]]),
    ];
    const points = [new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(2, 0, 0), new Vector3(3, 0, 0)];
    const offsets = points.map(() => new Vector3());
    offsets[0].set(0.5, 0, 0); offsets[1].set(0.5, 0, 0); offsets[2].set(0.5, 0, 0); offsets[3].set(-0.5, 0, 0);
    constrainGarmentFalloff(offsets, neighbors, points);
    for (let i = 0; i < 3; i++) {
      const length = points[i + 1].clone().add(offsets[i + 1]).sub(points[i]).sub(offsets[i]).length();
      expect(length).toBeGreaterThanOrEqual(1 / 1.475 - 0.001);
      expect(length).toBeLessThanOrEqual(1.4755);
    }
  });
});

describe('contact fit contracts', () => {
  it('holds every opening-loop vertex exactly while fitting', () => {
    const { garment, body } = fixture(), before = snapshotSurfaces(garment, body);
    fitSmoothGarment(garment, body);
    for (const [i, part] of garment.entries()) {
      for (const [j, point] of part.points.entries()) {
        if (Math.abs(before.garment[i].points[j].y) > 0.199) {
          expect(point.distanceTo(before.garment[i].points[j])).toBeLessThanOrEqual(SEAM_TOLERANCE);
        }
      }
    }
  }, HEAVY_FIT_TIMEOUT_MS);

  it('spreads the correction across the falloff neighbourhood', () => {
    const { garment, body } = fixture(), before = snapshotSurfaces(garment, body);
    fitSmoothGarment(garment, body);
    expect(Math.max(...ringDisplacements(garment[0], before.garment[0], 0.125))).toBeGreaterThan(0.001);
    expect(Math.max(...ringDisplacements(garment[0], before.garment[0], 0.175))).toBeGreaterThan(0.00002);
  }, HEAVY_FIT_TIMEOUT_MS);

  it('counts a partial vertex set for a local contact, never the whole garment', () => {
    const { garment, body } = fixture(), before = snapshotSurfaces(garment, body);
    const fit = fitSmoothGarment(garment, body);
    // Coincident seam duplicates share one welded position; the count also carries the
    // sub-micron tail of the falloff kernel, so it can exceed the visibly moved set.
    const movedPositions = new Set<string>();
    for (const [i, part] of garment.entries()) {
      for (const [j, point] of part.points.entries()) {
        if (point.distanceTo(before.garment[i].points[j]) > SEAM_TOLERANCE) {
          movedPositions.add(positionKey(before.garment[i].points[j]));
        }
      }
    }
    const total = garment.reduce((sum, part) => sum + part.points.length, 0);
    expect(movedPositions.size).toBeGreaterThan(0);
    expect(fit.movedVertices).toBeGreaterThanOrEqual(movedPositions.size);
    expect(fit.movedVertices).toBeLessThan(total / 2);
  }, HEAVY_FIT_TIMEOUT_MS);

  it('records the measured outside depth for the first pass', () => {
    const { garment, body } = fixture();
    const measured = measureNormalVertices(garment, body);
    const fit = fitSmoothGarment(garment, body);
    expect(fit.history[0]).toEqual({ pass: 0, outsideVertices: measured.outsideVertices,
      maxDepthMm: Math.max(0, ...measured.samples.filter(sample => sample.outside).map(sample => sample.depthMm)) });
  }, HEAVY_FIT_TIMEOUT_MS);

  it('returns the body surface as the coverage reference', () => {
    const { garment, body } = fixture();
    const fit = fitSmoothGarment(garment, body);
    const hits = new MeshBVH(fit.referenceBody).raycast(new Ray(new Vector3(), new Vector3(1, 0, 0)), DoubleSide);
    expect(Math.max(...hits.map(hit => hit.distance))).toBeGreaterThan(0.11);
  }, HEAVY_FIT_TIMEOUT_MS);

  it('honours the adjustment mask while its update nudges a covered vertex', () => {
    const { garment, body } = fixture();
    const reference = createCoverage(combinedSurface(garment), combinedSurface(body));
    const protectedBody = body.map(part => part.points.map(point => !reference.query(point)));
    const target = body[0].points[0];
    const nudged = target.clone().add(new Vector3(-0.0008, 0, 0));
    const fit = fitSmoothGarment(garment, body, {}, {
      reference, referenceBody: combinedSurface(body), protectedBody,
      update: () => { target.copy(nudged); },
    });
    expect(fit.shape.protectedBodyVerticesMoved).toBe(0);
    expect(target.equals(nudged)).toBe(true);
  }, HEAVY_FIT_TIMEOUT_MS);

  it('keeps a non-penetrating torso and an exposed limb exactly in place', () => {
    const { garment, body } = fixture(), before = snapshotSurfaces(garment, body);
    const fit = fitContactClearance(garment, body);
    expect(changedPoints(body[0], before.body[0])).toBe(0);
    expect(changedPoints(body[1], before.body[1])).toBe(0);
    expect(fit.shape.maxDisplacementMm).toBeGreaterThan(1);
  }, HEAVY_FIT_TIMEOUT_MS);

  it('moves a covered torso inside the shell on the first clear pass and reports it', () => {
    const { doc, garment, body } = authoredPair(
      [new CylinderGeometry(0.1, 0.1, 0.4, 96, 16, true)],
      [new CylinderGeometry(0.102, 0.102, 0.3, 32, 12)]);
    const before = snapshotSurfaces(garment, body);
    const fit = fitContactClearance(garment, body);
    expect(fit.history).toHaveLength(1);
    const changed = changedPoints(body[0], before.body[0]);
    expect(fit.torsoMovedVertices).toBe(changed);
    expect(changed).toBeGreaterThan(0);
    const radii = body[0].points.map(point => Math.hypot(point.x, point.z)).filter(radius => radius > 0.000001);
    expect(Math.max(...radii)).toBeLessThanOrEqual(0.0995);
    const reread = surfaceParts(doc, 'mannequin');
    const rereadRadii = reread[0].points.map(point => Math.hypot(point.x, point.z)).filter(radius => radius > 0.000001);
    expect(Math.max(...rereadRadii)).toBeLessThanOrEqual(0.0995);
  }, HEAVY_FIT_TIMEOUT_MS);

  it('keeps coincident seam vertices welded across garment parts', () => {
    const { garment, body } = authoredPair([
      new CylinderGeometry(0.1, 0.1, 0.2, 48, 8, true, 0, Math.PI),
      new CylinderGeometry(0.1, 0.1, 0.2, 48, 8, true, Math.PI, Math.PI),
    ], [new CylinderGeometry(0.075, 0.075, 0.12, 32, 6),
      new SphereGeometry(0.015, 16, 12).translate(0.105, 0, 0)]);
    const before = snapshotSurfaces(garment, body);
    fitSmoothGarment(garment, body);
    for (const [i, part] of garment.entries()) {
      for (const [j, point] of part.points.entries()) {
        if (Math.abs(before.garment[i].points[j].y) > 0.099) {
          expect(point.distanceTo(before.garment[i].points[j])).toBeLessThanOrEqual(SEAM_TOLERANCE);
        }
      }
    }
    const firstPart = new Map(garment[0].points.map((point, j) => [positionKey(point), j]));
    let pairs = 0;
    for (const point of garment[1].points) {
      const twin = firstPart.get(positionKey(point));
      if (twin === undefined) continue;
      pairs++;
      expect(point.distanceTo(garment[0].points[twin])).toBeLessThanOrEqual(SEAM_TOLERANCE);
    }
    expect(pairs).toBeGreaterThan(0);
  }, HEAVY_FIT_TIMEOUT_MS);

  it('spreads a contact over the tall garment support', () => {
    const { garment, body } = authoredPair(
      [new CylinderGeometry(0.1, 0.1, 0.8, 96, 8, true)],
      [new CylinderGeometry(0.075, 0.075, 0.12, 32, 6),
        new SphereGeometry(0.015, 16, 12).translate(0.105, 0, 0)]);
    const before = snapshotSurfaces(garment, body);
    fitSmoothGarment(garment, body);
    expect(Math.max(...ringDisplacements(garment[0], before.garment[0], 0.3))).toBeGreaterThan(0.0005);
  }, HEAVY_FIT_TIMEOUT_MS);

  it('fits a sub-millimetre garment and writes the followed body', () => {
    const { doc, garment, body } = authoredPair(
      [new CylinderGeometry(0.0015, 0.0015, 0.004, 24, 2, true)],
      [new CylinderGeometry(0.0008, 0.0008, 0.003, 16, 4),
        new SphereGeometry(0.0003, 12, 8).translate(0.0018, 0, 0)]);
    const before = snapshotSurfaces(garment, body);
    fitContactClearance(garment, body);
    const radii = body[0].points.map(point => Math.hypot(point.x, point.z)).filter(radius => radius > 0.000001);
    // The non-penetrating torso keeps its original wall radius; only the region
    // the widening shell exposes follows inward, so the maximum stays at 0.8 mm.
    expect(Math.max(...radii)).toBeGreaterThanOrEqual(0.00075);
    expect(Math.max(...radii)).toBeLessThanOrEqual(0.00085);
    const positions = surfaceParts(doc, 'mannequin')[0].primitive.getAttribute('POSITION')!;
    let written = 0;
    for (let i = 0; i < positions.getCount(); i++) {
      if (!new Vector3().fromArray(positions.getElement(i, [])).equals(before.body[0].points[i])) written++;
    }
    expect(written).toBeGreaterThan(0);
  }, HEAVY_FIT_TIMEOUT_MS);

  it('fits a straddling face without moving its protected corner', () => {
    const { garment, body } = authoredPair(
      [new CylinderGeometry(0.1, 0.1, 0.4, 96, 16, true)], [
        new CylinderGeometry(0.075, 0.075, 0.3, 32, 12),
        new SphereGeometry(0.015, 12, 8).translate(0.105, 0.17, 0),
        new SphereGeometry(0.012, 12, 8).translate(0.145, 0.17, 0),
        triangleGeometry([0.095, 0.17, 0.005], [0.095, 0.165, -0.005], [0.15, 0.168, 0], [1, 0, 0]),
      ]);
    const before = snapshotSurfaces(garment, body);
    const corner = body[3].points.findIndex(point => Math.hypot(point.x, point.z) > 0.14);
    expect(corner).toBeGreaterThanOrEqual(0);
    const fit = fitContactClearance(garment, body);
    expect(body[3].points[corner].equals(before.body[3].points[corner])).toBe(true);
    expect(fit.torsoMovedVertices).toBeGreaterThan(0);
    // The anchored follow clears the straddling corners within two passes; a
    // follow that drops its deepest proposal needs six on this fixture.
    expect(fit.history).toHaveLength(2);
  }, HEAVY_FIT_TIMEOUT_MS);

  it('refuses a garment that already crosses itself even without any contact', () => {
    const { garment, body } = authoredPair([
      new CylinderGeometry(0.1, 0.1, 0.4, 96, 16, true),
      triangleGeometry([0.15, 0.095, -0.005], [0.15, 0.105, -0.005], [0.15, 0.1, 0.005], [1, 0, 0]),
      triangleGeometry([0.152, 0.097, -0.003], [0.152, 0.103, -0.003], [0.147, 0.1, 0.003], [1, 0, 0]),
    ], [new CylinderGeometry(0.075, 0.075, 0.3, 32, 12)]);
    expect(() => assertNoSurfaceIntersections(garment)).toThrow('Garment self-intersection');
    expect(() => fitContactClearance(garment, body)).toThrow('Garment self-intersection');
  }, HEAVY_FIT_TIMEOUT_MS);

  it('keeps a deeply poked covered vertex on its own side of the axis', () => {
    // One face spans from a covered near-axis vertex to a deep radial poke: the
    // prefit must move the far side fully while the near vertex stops at the
    // fit-margin floor instead of crossing the section centre.
    const { garment, body } = authoredPair(
      [new CylinderGeometry(0.1, 0.1, 0.4, 96, 16, true)],
      [triangleGeometry([0.02, 0, 0.0005], [0.11, -0.01, -0.0005], [0.13, 0.01, -0.0005], [1, 0, 0])]);
    const before = snapshotSurfaces(garment, body);
    const fit = fitContactClearance(garment, body);
    expect(body[0].points[0].x).toBeGreaterThan(0);
    expect(body[0].points[0].x).toBeLessThan(0.015);
    expect(body[0].points[1].distanceTo(before.body[0].points[1])).toBeLessThanOrEqual(SEAM_TOLERANCE);
    expect(fit.torsoMovedVertices).toBeGreaterThan(0);
  }, HEAVY_FIT_TIMEOUT_MS);

  it('converges the single limb fit within its measured pass budget', () => {
    // The reference cylinder-and-limb fit settles in 8 passes. Contact exits that
    // point back into the body stretch it to 9, so the depth is pinned.
    const { garment, body } = fixture();
    const fit = fitSmoothGarment(garment, body);
    expect(fit.history).toHaveLength(8);
  }, HEAVY_FIT_TIMEOUT_MS);
});
