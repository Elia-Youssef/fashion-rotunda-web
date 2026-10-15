import { Document } from '@gltf-transform/core';
import { KHRMaterialsVariants } from '@gltf-transform/extensions';
import type { MappingList } from '@gltf-transform/extensions';
import { cloneDocument } from '@gltf-transform/functions';
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { applyLookFit, fitCoveredSurface, validateFitOutput } from '../../pipeline/gltf/lib/garment-fit.mjs';
import { combinedSurface, createCoverage, measureSurface, surfaceParts, surfaceTopology } from '../../pipeline/gltf/lib/garment-coverage.mjs';

function part(geometry: BufferGeometry) {
  const p = geometry.getAttribute('position');
  return { points: Array.from({ length: p.count }, (_, i) => new Vector3().fromBufferAttribute(p, i)),
    indices: Array.from(geometry.getIndex()!.array), matrix: new Matrix4() };
}

function shell() {
  const g = new BufferGeometry();
  // Four outward-wound sides. The top and bottom are genuine openings.
  g.setAttribute('position', new Float32BufferAttribute([
    -1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1,
    -1,-1,1, 1,-1,1, 1,1,1, -1,1,1,
  ], 3));
  g.setIndex([0,2,1,0,3,2, 4,5,6,4,6,7, 0,4,7,0,7,3, 1,2,6,1,6,5]);
  return g;
}

/** The shell with its +x side removed: the reference shell still covers that direction. */
function openedShell() {
  const g = shell();
  const index = g.getIndex()!;
  g.setIndex(Array.from(index.array).slice(0, index.count - 6));
  return g;
}

/**
 * A three-ring tube whose middle ring is pinched to 0.2 mm exits. A body vertex capped at the
 * one-millimetre fit margin can never clear an exit below 0.9 mm, so the fit must refuse.
 */
function pinchedTube() {
  const rings = [{ y: -1, x: 1 }, { y: 0, x: 0.0002 }, { y: 1, x: 1 }]
    .map(({ y, x }) => [[x, y, 1], [x, y, -1], [-x, y, -1], [-x, y, 1]]);
  const indices: number[] = [];
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let side = 0; side < 4; side++) {
      const a = ring * 4 + side, b = ring * 4 + (side + 1) % 4;
      const c = (ring + 1) * 4 + (side + 1) % 4, d = (ring + 1) * 4 + side;
      indices.push(a, b, c, a, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(rings.flat(2), 3));
  g.setIndex(indices);
  return g;
}

function body() {
  return new BoxGeometry(2.2, 1.6, 1.2);
}

/** A garment group whose single primitive violates one static-geometry requirement. */
function invalidGarmentDocument(kind: 'points' | 'skinned' | 'morph' | 'bare') {
  const doc = new Document(), scene = doc.createScene(), buffer = doc.createBuffer();
  const position = doc.createAccessor().setBuffer(buffer).setType('VEC3')
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const primitive = doc.createPrimitive();
  if (kind !== 'bare') primitive.setAttribute('POSITION', position);
  if (kind === 'points') primitive.setMode(0);
  if (kind === 'morph') {
    primitive.addTarget(doc.createPrimitiveTarget().setAttribute('POSITION',
      doc.createAccessor().setBuffer(buffer).setType('VEC3')
        .setArray(new Float32Array([0, 0, 0.001, 1, 0, 0.001, 0, 1, 0.001]))));
  }
  const node = doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive));
  if (kind === 'skinned') node.setSkin(doc.createSkin());
  const group = doc.createNode('garment');
  group.addChild(node);
  scene.addChild(group);
  return doc;
}

describe('covered surface fitting', () => {
  it('excludes the first body interval when the ray begins in air and the limb is beyond the shell', () => {
    const garment = [part(shell())], limb = [part(new BoxGeometry(0.2, 0.4, 0.2).translate(1.6, 0, 0))];
    for (const options of [{}, { includeIntersectingIntervals: true }]) {
      const coverage = createCoverage(combinedSurface(garment), combinedSurface(limb), null, options);
      expect(measureSurface(limb, coverage).coveredSamples).toBe(0);
    }
  });
  it('moves each fitted corner radially without changing its horizontal bearing or height', () => {
    const garment = [part(shell())], mannequin = [part(body())];
    const original = mannequin[0].points.map(p => p.clone());
    fitCoveredSurface(garment, mannequin, 'body-inward');
    for (const [i, point] of mannequin[0].points.entries()) {
      expect(point.y).toBe(original[i].y);
      expect(Math.abs(point.x * original[i].z - point.z * original[i].x)).toBeLessThan(0.000001);
      expect(point.x * original[i].x + point.z * original[i].z).toBeGreaterThanOrEqual(0);
    }
  });
  it('fits later body intervals that cross the shell while preserving wholly exposed limbs', () => {
    const garment = [part(shell())], torso = part(new BoxGeometry(1.2, 1.6, 1.2));
    const crossing = part(new BoxGeometry(0.4, 0.4, 0.4).translate(1, 0, 0));
    const exposed = part(new BoxGeometry(0.2, 0.4, 0.2).translate(1.6, 0, 0));
    const mannequin = [torso, crossing, exposed];
    const base = createCoverage(combinedSurface(garment), combinedSurface(mannequin));
    expect(measureSurface([crossing], base).outsideSamples).toBe(0);
    const options = { includeIntersectingIntervals: true };
    const coverage = createCoverage(combinedSurface(garment), combinedSurface(mannequin), null, options);
    expect(measureSurface([crossing], coverage).outsideSamples).toBeGreaterThan(0);
    expect(measureSurface([exposed], coverage).coveredSamples).toBe(0);
    const before = exposed.points.map(p => p.toArray());
    const result = fitCoveredSurface(garment, mannequin, 'body-inward', options);
    expect(measureSurface(mannequin, result.reference).outsideSamples).toBe(0);
    expect(exposed.points.map(p => p.toArray())).toEqual(before);
  });
  it.each(['body-inward', 'garment-outward'] as const)('%s resolves real surface penetration without removing triangles', (method) => {
    const garment = [part(shell())], mannequin = [part(body())];
    const coverage = createCoverage(combinedSurface(garment), combinedSurface(mannequin));
    expect(measureSurface(mannequin, coverage).outsideSamples).toBeGreaterThan(0);
    const garmentIndices = [...garment[0].indices], bodyIndices = [...mannequin[0].indices];
    const result = fitCoveredSurface(garment, mannequin, method);
    const fitted = method === 'body-inward' ? result.reference : createCoverage(combinedSurface(garment), combinedSurface(mannequin));
    expect(measureSurface(mannequin, fitted).outsideSamples).toBe(0);
    expect(garment[0].indices).toEqual(garmentIndices);
    expect(mannequin[0].indices).toEqual(bodyIndices);
    expect(result.movedVertices).toBeGreaterThan(0);
  });

  it('keeps separate exposed limbs and body surfaces above and below openings unchanged', () => {
    const garment = [part(shell())], torso = part(body());
    const hand = part(new BoxGeometry(0.2, 0.4, 0.2).translate(1.6, 0, 0));
    const head = part(new BoxGeometry(0.4, 0.4, 0.4).translate(0, 1.4, 0));
    const foot = part(new BoxGeometry(0.4, 0.4, 0.4).translate(0, -1.4, 0));
    const exposed = [hand, head, foot].map((p) => p.points.map((v) => v.toArray()));
    fitCoveredSurface(garment, [torso, hand, head, foot], 'body-inward');
    expect([hand, head, foot].map((p) => p.points.map((v) => v.toArray()))).toEqual(exposed);
  });

  it('welds topology seams and rejects an inverted face rather than hiding it', () => {
    const g = shell().toNonIndexed();
    g.setIndex(Array.from({ length: g.getAttribute('position').count }, (_, i) => i));
    expect(surfaceTopology(g)).toMatchObject({ degenerateFaces: 0, nonManifoldEdges: 0, inconsistentEdges: 0 });
    expect(surfaceTopology(g).loops).toHaveLength(2);
    const index = g.getIndex()!;
    index.setX(0, 1); index.setX(1, 0);
    expect(() => createCoverage(g, body())).toThrow('invalid topology');
  });

  it('preserves policy opt-in and variant mappings when requesting inward fitting', () => {
    const doc = new Document(), scene = doc.createScene(), buffer = doc.createBuffer();
    const variants = doc.createExtension(KHRMaterialsVariants);
    const mannequin = body();
    for (const [name, geometry] of [['garment', shell()], ['mannequin', mannequin]] as const) {
      const p = geometry.getAttribute('position');
      const primitive = doc.createPrimitive()
        .setAttribute('POSITION', doc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(new Float32Array(p.array)))
        .setIndices(doc.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(new Uint32Array(geometry.getIndex()!.array)));
      if (name === 'mannequin') {
        const list = variants.createMappingList();
        for (const value of ['base', 'light', 'dark']) {
          list.addMapping(variants.createMapping().setMaterial(doc.createMaterial(value)).addVariant(variants.createVariant(value)));
        }
        primitive.setExtension('KHR_materials_variants', list);
      }
      const group = doc.createNode(name), node = doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive));
      group.addChild(node); scene.addChild(group);
    }
    const garmentBefore = [...surfaceParts(doc, 'garment')[0].primitive.getAttribute('POSITION')!.getArray()!];
    const broken = cloneDocument(doc);
    expect(applyLookFit(doc, 'unaffected')).toEqual({ applied: false });
    const fit = applyLookFit(doc, 'mondrian-dress', 'body-inward');
    expect(fit).toMatchObject({ applied: true, method: 'body-inward' });
    const extended = createCoverage(combinedSurface(surfaceParts(doc, 'garment')),
      combinedSurface(surfaceParts(broken, 'mannequin')), null, { includeIntersectingIntervals: true });
    expect(measureSurface(surfaceParts(doc, 'mannequin'), extended).outsideSamples).toBe(0);
    expect(validateFitOutput(doc, fit)).toMatchObject({ checked: true, outsideSamples: 0 });
    expect(() => validateFitOutput(broken, fit)).toThrow('Serialized garment fit failed');
    expect([...surfaceParts(doc, 'garment')[0].primitive.getAttribute('POSITION')!.getArray()!]).toEqual(garmentBefore);
    const mapping = surfaceParts(doc, 'mannequin')[0].primitive.getExtension<MappingList>('KHR_materials_variants')!;
    expect(mapping.listMappings().flatMap((m: { listVariants(): { getName(): string }[] }) => m.listVariants().map((v) => v.getName())))
      .toEqual(['base', 'light', 'dark']);
  });
});

describe('covered surface fitting refusals', () => {
  it.each(['points', 'skinned', 'morph', 'bare'] as const)('rejects %s garment geometry', (kind) => {
    const expected = kind === 'points'
      ? 'Garment coverage requires triangle primitives'
      : 'Garment coverage requires static position geometry';
    expect(() => surfaceParts(invalidGarmentDocument(kind), 'garment')).toThrow(expected);
  });

  it('rejects a garment group absent from every scene', () => {
    const doc = new Document();
    doc.createScene().addChild(doc.createNode('mannequin'));
    expect(() => surfaceParts(doc, 'garment')).toThrow('Missing surface group garment');
  });

  it('rejects a fit that opens a direction the reference shell covered', () => {
    const bodyParts = [part(body())];
    const reference = createCoverage(combinedSurface([part(shell())]), combinedSurface(bodyParts));
    const opened = createCoverage(combinedSurface([part(openedShell())]), combinedSurface(bodyParts), reference);
    expect(() => opened.query(new Vector3(1.1, 0, 0)))
      .toThrow('Fitting opened a previously covered garment direction');
  });

  it('rejects an unknown fit method before touching any geometry', () => {
    expect(() => fitCoveredSurface([part(shell())], [part(body())],
      // @ts-expect-error The unknown method name is exactly what the refusal under test receives.
      'sideways')).toThrow('Unknown fit method sideways');
  });

  it('refuses a body that can never clear a sub-millimetre shell exit', () => {
    expect(() => fitCoveredSurface([part(pinchedTube())], [part(body())], 'body-inward'))
      .toThrow('Garment fit did not converge');
  });

  it('skips serialized validation for a look the fit policy did not touch', () => {
    const fit = applyLookFit(new Document(), 'unaffected');
    expect(validateFitOutput(new Document(), fit)).toEqual({ checked: false });
  });
});
