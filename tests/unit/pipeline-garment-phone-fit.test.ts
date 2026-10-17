import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { BoxGeometry, BufferGeometry, SphereGeometry } from 'three';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { beforeAll, describe, expect, it } from 'vitest';
import { surfaceParts } from '../../pipeline/gltf/lib/garment-coverage.mjs';
import { fitNormalInward, measureNormalFaces } from '../../pipeline/gltf/lib/garment-normal-fit.mjs';
import { applyHalfLookFit, HALF_LOOK_FIT_POLICIES, surfaceTriangles } from '../../pipeline/gltf/lib/garment-phone-fit.mjs';
import { compareGarmentViews } from '../../pipeline/gltf/lib/garment-view.mjs';

function document(garment: BufferGeometry, body: BufferGeometry) {
  const doc = new Document(), scene = doc.createScene(), buffer = doc.createBuffer();
  for (const [name, geometry] of [['garment', garment], ['mannequin', body]] as const) {
    const primitive = doc.createPrimitive();
    for (const [semantic, attribute] of [['POSITION', 'position'], ['NORMAL', 'normal']] as const) {
      primitive.setAttribute(semantic, doc.createAccessor().setBuffer(buffer).setType('VEC3')
        .setArray(new Float32Array(geometry.getAttribute(attribute).array)));
    }
    primitive.setIndices(doc.createAccessor().setBuffer(buffer).setType('SCALAR')
      .setArray(new Uint32Array(geometry.getIndex()!.array)));
    scene.addChild(doc.createNode(name).setMesh(doc.createMesh().addPrimitive(primitive)));
  }
  return doc;
}

const policy = { garmentGroup: 'garment', bodyGroup: 'mannequin', clearance: 0.002,
  extraFraction: 0.1, maxPasses: 24 };
const positions = (doc: Document) => surfaceParts(doc, 'mannequin')[0].points.map(p => p.toArray());

beforeAll(async () => { await Promise.all([MeshoptSimplifier.ready, MeshoptEncoder.ready, MeshoptDecoder.ready]); });

describe('phone garment fitting', () => {
  it('opts in the phone budget split and displacement fraction through one policy entry', () => {
    expect(Object.keys(HALF_LOOK_FIT_POLICIES)).toEqual(['wallis-dress']);
    expect(HALF_LOOK_FIT_POLICIES['wallis-dress']).toMatchObject({ bodyTriangles: 60000,
      clearance: 0.002, extraFraction: 0.1 });
  });

  it('leaves all full looks and unlisted half looks byte-identical in their position attributes', () => {
    const doc = document(new BoxGeometry(2, 2, 2), new BoxGeometry(2.04, 1.6, 1.2));
    const before = positions(doc);
    expect(applyHalfLookFit(doc, 'wallis-dress', 'full', 120000, MeshoptSimplifier, 0.005)).toEqual({ applied: false });
    expect(applyHalfLookFit(doc, 'unlisted', 'half', 120000, MeshoptSimplifier, 0.005)).toEqual({ applied: false });
    expect(positions(doc)).toEqual(before);
  });

  it('simplifies the body before calculating the garment allowance and enforces both budgets', () => {
    HALF_LOOK_FIT_POLICIES.fixture = { ...policy, bodyTriangles: 180 };
    try {
      const doc = document(new SphereGeometry(1, 32, 20), new SphereGeometry(0.7, 24, 16));
      const result = applyHalfLookFit(doc, 'fixture', 'half', 500, MeshoptSimplifier, 0.5);
      expect(result.applied).toBe(true);
      expect(surfaceTriangles(surfaceParts(doc, 'mannequin'))).toBeLessThanOrEqual(180);
      expect(surfaceTriangles(surfaceParts(doc, 'garment')) + surfaceTriangles(surfaceParts(doc, 'mannequin')))
        .toBeLessThanOrEqual(500);
      expect(surfaceTriangles(surfaceParts(doc, 'garment'))).toBeGreaterThan(300);
    } finally { delete HALF_LOOK_FIT_POLICIES.fixture; }
  });

  it('moves every face with an outside corner, midpoint or centroid inward until probes clear', () => {
    const doc = document(new BoxGeometry(2, 2, 2), new BoxGeometry(2.04, 1.6, 1.2));
    const garment = surfaceParts(doc, 'garment');
    expect(measureNormalFaces(garment, surfaceParts(doc, 'mannequin')).measurement.outsideVertices).toBeGreaterThan(0);
    const result = fitNormalInward(doc, policy);
    expect(result.history.at(-1)?.outsideProbes).toBe(0);
    expect(result.movedVertices).toBeGreaterThan(0);
    expect(measureNormalFaces(garment, surfaceParts(doc, 'mannequin')).measurement.outsideVertices).toBe(0);
    expect(surfaceTriangles(surfaceParts(doc, 'mannequin'))).toBe(12);
  });

  it('extends each moved vertex by ten percent of its own accumulated displacement', () => {
    const make = () => document(new BoxGeometry(2, 2, 2), new BoxGeometry(2.04, 1.6, 1.2).translate(0.005, 0, 0));
    const base = make(), extra = make(), initial = positions(base);
    fitNormalInward(base, { ...policy, extraFraction: 0 });
    const result = fitNormalInward(extra, policy);
    const a = positions(base), b = positions(extra);
    expect(result.maxExtraMm).toBeGreaterThan(0);
    for (let i = 0; i < a.length; i++) for (let axis = 0; axis < 3; axis++) {
      expect(b[i][axis] - initial[i][axis]).toBeCloseTo((a[i][axis] - initial[i][axis]) * 1.1, 6);
    }
  });

  it('fails closed at the pass limit instead of returning an incomplete fit', () => {
    const doc = document(new BoxGeometry(2, 2, 2), new BoxGeometry(2.04, 1.6, 1.2));
    expect(() => fitNormalInward(doc, { ...policy, maxPasses: 0 })).toThrow('did not converge');
  });

  it('clears visible contacts smaller than the diagnostic tolerance through encoding', async () => {
    const doc = document(new BoxGeometry(2, 2, 2), new BoxGeometry(1.6, 1.6, 2.0001));
    const parts = (d: Document) => ({ garment: surfaceParts(d, 'garment'), body: surfaceParts(d, 'mannequin') });
    const reference = document(new BoxGeometry(2.01, 2.01, 2.01), new BoxGeometry(1.6, 1.6, 2.0001));
    const view = { position: [0, 0, 4], target: [0, 0, 0], fov: 40 };
    expect(measureNormalFaces(parts(doc).garment, parts(doc).body).measurement.outsideVertices).toBe(0);
    expect(compareGarmentViews(parts(reference), parts(doc), view, 39, 84).exposedBodyPixels).toBeGreaterThan(0);
    fitNormalInward(doc, HALF_LOOK_FIT_POLICIES['wallis-dress']);
    expect(compareGarmentViews(parts(reference), parts(doc), view, 39, 84).exposedBodyPixels).toBe(0);
    await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder,
    });
    const serialized = await io.readBinary(await io.writeBinary(doc));
    expect(compareGarmentViews(parts(reference), parts(serialized), view, 39, 84).exposedBodyPixels).toBe(0);
  });

  it('keeps every incident face on a shared corner or edge probe', () => {
    const doc = document(new BoxGeometry(2, 2, 2), new BoxGeometry(2.04, 1.6, 1.2));
    const { owners } = measureNormalFaces(surfaceParts(doc, 'garment'), surfaceParts(doc, 'mannequin'));
    expect(owners.size).toBe(38);
    expect([...owners.values()].some(vertices => vertices.size > 3)).toBe(true);
  });
});

describe('offline garment visibility', () => {
  const view = { position: [0, 0, 4], target: [0, 0, 0], fov: 40 };
  const parts = (doc: Document) => ({ garment: surfaceParts(doc, 'garment'), body: surfaceParts(doc, 'mannequin') });

  it('counts first-hit body rays through lost fabric and records their three dimensional locations', () => {
    const reference = document(new BoxGeometry(2, 2, 2), new BoxGeometry(1.5, 1.5, 1.5));
    const candidate = document(new BoxGeometry(0.1, 0.1, 0.1).translate(3, 0, 0), new BoxGeometry(1.5, 1.5, 1.5));
    expect(compareGarmentViews(parts(reference), parts(reference), view, 39, 84).exposedBodyPixels).toBe(0);
    const broken = compareGarmentViews(parts(reference), parts(candidate), view, 39, 84);
    expect(broken.exposedBodyPixels).toBeGreaterThan(0);
    expect(broken.samples.every(sample => Math.abs(sample.bodyPoint[2] - 0.75) < 0.00001)).toBe(true);
  });

  it('distinguishes missing fabric from fabric behind the body and back-facing fabric', () => {
    const reference = document(new BoxGeometry(2, 2, 2), new BoxGeometry(1.5, 1.5, 1.5));
    const candidate = document(new BoxGeometry(2, 2, 1.4), new BoxGeometry(1.5, 1.5, 1.5));
    const overlap = compareGarmentViews(parts(reference), parts(candidate), view, 39, 84);
    expect(overlap.samples.every(sample => sample.gapMm !== null && sample.gapMm > 0 && !sample.backfaceOnly)).toBe(true);
    const garment = surfaceParts(reference, 'garment')[0].primitive.getIndices()!;
    const indices = garment.getArray()!.slice();
    for (let i = 0; i < indices.length; i += 3) [indices[i], indices[i + 1]] = [indices[i + 1], indices[i]];
    garment.setArray(indices);
    const back = compareGarmentViews(parts(document(new BoxGeometry(2, 2, 2), new BoxGeometry(1.5, 1.5, 1.5))),
      parts(reference), view, 39, 84);
    expect(back.samples.some(sample => sample.backfaceOnly)).toBe(true);
  });
});
