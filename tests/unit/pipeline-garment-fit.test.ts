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

function body() {
  return new BoxGeometry(2.2, 1.6, 1.2);
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
