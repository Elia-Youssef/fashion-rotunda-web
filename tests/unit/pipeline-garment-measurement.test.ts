import { Document } from '@gltf-transform/core';
import { BoxGeometry, BufferGeometry, Float32BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import { surfaceParts, combinedSurface, createCoverage } from '../../pipeline/gltf/lib/garment-coverage.mjs';
import { measureNormalVertices } from '../../pipeline/gltf/lib/garment-measurement.mjs';

function document(garment: BufferGeometry, body: BufferGeometry) {
  const doc = new Document(), scene = doc.createScene(), buffer = doc.createBuffer();
  for (const [name, geometry] of [['garment', garment], ['mannequin', body]] as const) {
    const primitive = doc.createPrimitive();
    for (const [attribute, field] of [['POSITION', 'position'], ['NORMAL', 'normal']] as const) {
      const value = geometry.getAttribute(field);
      primitive.setAttribute(attribute, doc.createAccessor().setBuffer(buffer).setType('VEC3')
        .setArray(new Float32Array(value.array)));
    }
    primitive.setIndices(doc.createAccessor().setBuffer(buffer).setType('SCALAR')
      .setArray(new Uint32Array(geometry.getIndex()!.array)));
    scene.addChild(doc.createNode(name).setMesh(doc.createMesh().addPrimitive(primitive)));
  }
  return doc;
}

function shell() {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([
    -1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1,
    -1,-1,1, 1,-1,1, 1,1,1, -1,1,1,
  ], 3));
  g.setIndex([0,2,1,0,3,2, 4,5,6,4,6,7, 0,4,7,0,7,3, 1,2,6,1,6,5]);
  g.computeVertexNormals(); return g;
}

describe('normal garment measurement', () => {
  it('does not grant coverage through an inward-facing garment entry', () => {
    const garment = shell(), index = [...garment.getIndex()!.array];
    for (let i = 0; i < index.length; i += 3) [index[i], index[i + 1]] = [index[i + 1], index[i]];
    garment.setIndex(index);
    const doc = document(garment, new BoxGeometry(2.04, 1.6, 1.2));
    expect(measureNormalVertices(surfaceParts(doc, 'garment'), surfaceParts(doc, 'mannequin')).coveredVertices).toBe(0);
  });

  it('rejects a normal probe reaching the opposite garment hemisphere', () => {
    const body = new BoxGeometry(0.2, 0.2, 0.2), normals = body.getAttribute('normal');
    for (let i = 0; i < normals.count; i++) normals.setXYZ(i, 1, 0, 0);
    const doc = document(shell(), body);
    const measured = measureNormalVertices(surfaceParts(doc, 'garment'), surfaceParts(doc, 'mannequin'));
    expect(measured.samples.filter(sample => sample.point[0] < 0)).toHaveLength(0);
    expect(measured.samples.filter(sample => sample.point[0] > 0).length).toBeGreaterThan(0);
  });
  it('excludes an exposed first limb interval beyond the garment when its centre ray begins in air', () => {
    const doc = document(shell(), new BoxGeometry(0.2, 0.4, 0.2).translate(1.6, 0, 0));
    expect(measureNormalVertices(surfaceParts(doc, 'garment'), surfaceParts(doc, 'mannequin')).coveredVertices).toBe(0);
  });
  it('reports positive inward depth for an outside body and negative outward depth for an inside body', () => {
    for (const [width, sign] of [[2.04, 1], [1.96, -1]]) {
      const doc = document(shell(), new BoxGeometry(width, 1.6, 1.2));
      const measurement = measureNormalVertices(surfaceParts(doc, 'garment'), surfaceParts(doc, 'mannequin'));
      const side = measurement.samples.filter(sample => Math.abs(sample.point[0]) > 0.97);
      expect(side.length).toBeGreaterThan(0);
      expect(side.every(sample => Math.sign(sample.depthMm) === sign)).toBe(true);
      expect(Math.max(...side.map(sample => Math.abs(sample.depthMm)))).toBeLessThan(50);
      expect(measurement.outsideVertices > 0).toBe(sign > 0);
    }
  });

  it('measures a non-manifold shell without modifying positions, indices or fitting admission', () => {
    const garment = shell(); garment.setIndex([...garment.getIndex()!.array, 0, 2, 1]);
    const doc = document(garment, new BoxGeometry(2.04, 1.6, 1.2));
    const parts = surfaceParts(doc, 'garment'), body = surfaceParts(doc, 'mannequin');
    const before = parts.map(part => ({ indices: [...part.indices], points: part.points.map(p => p.toArray()) }));
    const bodyBefore = body.map(part => ({ indices: [...part.indices], points: part.points.map(p => p.toArray()) }));
    expect(measureNormalVertices(parts, body).outsideVertices).toBeGreaterThan(0);
    expect(parts.map(part => ({ indices: [...part.indices], points: part.points.map(p => p.toArray()) }))).toEqual(before);
    expect(body.map(part => ({ indices: [...part.indices], points: part.points.map(p => p.toArray()) }))).toEqual(bodyBefore);
    expect(() => createCoverage(combinedSurface(parts), combinedSurface(body))).toThrow('invalid topology');
  });

  it('rejects missing normal data instead of silently substituting radial probes', () => {
    const doc = document(shell(), new BoxGeometry(2.04, 1.6, 1.2));
    const body = surfaceParts(doc, 'mannequin'); body[0].primitive.setAttribute('NORMAL', null);
    expect(() => measureNormalVertices(surfaceParts(doc, 'garment'), body)).toThrow('requires authored');
  });

  it('does not label a sole ray reaching a remote garment height as local poke-through', () => {
    const garment = shell();
    // A downward-facing layer above the body is remote fabric, not a local sole cover.
    garment.setIndex([...garment.getIndex()!.array, 3, 2, 6, 3, 6, 7]);
    const body = new BoxGeometry(1.2, 1.6, 1.2);
    // All vertices face down: inward rays can reach another garment height, not local fabric.
    const normals = body.getAttribute('normal');
    for (let i = 0; i < normals.count; i++) normals.setXYZ(i, 0, -1, 0);
    const doc = document(garment, body);
    expect(measureNormalVertices(surfaceParts(doc, 'garment'), surfaceParts(doc, 'mannequin')).outsideVertices).toBe(0);
  });
});
