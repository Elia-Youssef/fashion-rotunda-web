import { Accessor, Document, Primitive } from '@gltf-transform/core';
import { Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { writeFittedParts } from '../../pipeline/gltf/lib/garment-attributes.mjs';

interface FittedPart {
  matrix: Matrix4;
  primitive: Primitive;
  points: Vector3[];
  indices: number[];
}

/** A part whose primitive carries the given local-space attributes and scene-space points. */
function fittedPart(options: {
  local: number[][],
  normals?: number[][],
  tangents?: number[][],
  indices: number[],
  matrix?: Matrix4,
}): FittedPart {
  const { local, normals, tangents, indices } = options;
  const matrix = options.matrix ?? new Matrix4();
  const doc = new Document(), buffer = doc.createBuffer(), primitive = doc.createPrimitive();
  const attribute = (type: 'VEC3' | 'VEC4', values: number[][]) =>
    doc.createAccessor().setType(type).setBuffer(buffer).setArray(new Float32Array(values.flat()));
  primitive.setAttribute('POSITION', attribute('VEC3', local));
  if (normals) primitive.setAttribute('NORMAL', attribute('VEC3', normals));
  if (tangents) primitive.setAttribute('TANGENT', attribute('VEC4', tangents));
  primitive.setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buffer)
    .setArray(new Uint32Array(indices)));
  return {
    matrix,
    primitive,
    points: local.map((v) => new Vector3(...v).applyMatrix4(matrix)),
    indices,
  };
}

function readAttribute(part: FittedPart, name: 'POSITION' | 'NORMAL' | 'TANGENT'): Accessor {
  return part.primitive.getAttribute(name)!;
}

/** Accessors store float32, so expectations are rounded through the same width. */
function f32(vector: Vector3): number[] {
  return Array.from(Float32Array.of(vector.x, vector.y, vector.z));
}

function faceNormal(a: Vector3, b: Vector3, c: Vector3): Vector3 {
  return new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
}

/** Face sums accumulate into a zero vector, which folds signed zeros to plus zero. */
function faceSum(...normals: Vector3[]): Vector3 {
  return normals.reduce((sum, normal) => sum.add(normal), new Vector3());
}

describe('fitted garment attribute writeback', () => {
  it('writes fitted positions in local space and keeps scene-space points intact', () => {
    const translated = fittedPart({
      local: [[0, 0, 0], [2, 0, 0], [0, 2, 0]],
      normals: [[0, 1, 0], [0, 1, 0], [0, 1, 0]],
      indices: [0, 1, 2],
      matrix: new Matrix4().makeTranslation(10, 0, 0),
    });
    const plain = fittedPart({
      local: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      normals: [[0, -1, 0], [0, -1, 0], [0, -1, 0]],
      indices: [0, 1, 2],
    });
    translated.points[2].add(new Vector3(0, 0, 1));
    plain.points[0].add(new Vector3(0, 0, 0.5));
    const sceneBefore = [translated.points.map((p) => p.toArray()), plain.points.map((p) => p.toArray())];

    writeFittedParts([translated, plain]);

    expect(readAttribute(translated, 'POSITION').getElement(2, [])).toEqual([0, 2, 1]);
    expect(readAttribute(translated, 'POSITION').getElement(0, [])).toEqual([0, 0, 0]);
    expect(readAttribute(plain, 'POSITION').getElement(0, [])).toEqual([0, 0, 0.5]);
    expect(readAttribute(plain, 'POSITION').getElement(1, [])).toEqual([1, 0, 0]);
    expect(translated.points.map((p) => p.toArray())).toEqual(sceneBefore[0]);
    expect(plain.points.map((p) => p.toArray())).toEqual(sceneBefore[1]);
    const translatedNormal = f32(faceSum(faceNormal(translated.points[0], translated.points[1],
      translated.points[2])).normalize());
    const plainNormal = f32(faceSum(faceNormal(plain.points[0], plain.points[1],
      plain.points[2])).normalize());
    for (const i of [0, 1, 2]) {
      expect(readAttribute(translated, 'NORMAL').getElement(i, [])).toEqual(translatedNormal);
      expect(readAttribute(plain, 'NORMAL').getElement(i, [])).toEqual(plainNormal);
    }
  });

  it('smooths recomputed normals across welded seam vertices and keeps unchanged vertices authored', () => {
    // The second face re-declares the shared edge as its own vertices, the shape of an
    // exported UV seam; only the first face moves.
    const part = fittedPart({
      local: [[0, 0, 0], [2, 0, 0], [0, 2, 0], [2, 0, 0], [0, 2, 0], [2, 2, 1]],
      normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1], [0, 1, 0], [0, 1, 0], [0, 1, 0]],
      indices: [0, 1, 2, 3, 4, 5],
    });
    part.points[0].add(new Vector3(0.01, 0, 0));
    const first = faceNormal(part.points[0], part.points[1], part.points[2]);
    const second = faceNormal(part.points[3], part.points[4], part.points[5]);
    // Face corners b and c are duplicated, so their sums carry both incident faces.
    const seamNormal = f32(faceSum(first, second).normalize());
    const firstNormal = f32(faceSum(first).normalize());

    writeFittedParts([part]);

    expect(readAttribute(part, 'POSITION').getElement(0, [])).toEqual(f32(new Vector3(0.01, 0, 0)));
    expect(readAttribute(part, 'POSITION').getElement(5, [])).toEqual([2, 2, 1]);
    expect(readAttribute(part, 'NORMAL').getElement(0, [])).toEqual(firstNormal);
    expect(readAttribute(part, 'NORMAL').getElement(1, [])).toEqual(seamNormal);
    expect(readAttribute(part, 'NORMAL').getElement(3, [])).toEqual(seamNormal);
    expect(readAttribute(part, 'NORMAL').getElement(2, [])).toEqual(seamNormal);
    expect(readAttribute(part, 'NORMAL').getElement(4, [])).toEqual(seamNormal);
    expect(readAttribute(part, 'NORMAL').getElement(5, [])).toEqual([0, 1, 0]);
  });

  it('keeps seam vertices apart unless they sit within the weld tolerance', () => {
    // One tenth of a millimetre separates the duplicated edge, far above the one micrometre
    // weld tolerance: the two sides must keep their own face normals.
    const split = 0.0001;
    const part = fittedPart({
      local: [[0, 0, 0], [1, 0, 0], [0, 1, 0],
        [1 + split, 0, 0], [split, 1 + split, 0], [1, 1, 0.5]],
      normals: [[0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0], [0, 1, 0]],
      indices: [0, 1, 2, 3, 4, 5],
    });
    part.points[0].add(new Vector3(0.01, 0, 0));
    part.points[5].add(new Vector3(0.01, 0, 0));
    const first = faceNormal(part.points[0], part.points[1], part.points[2]);
    const second = faceNormal(part.points[3], part.points[4], part.points[5]);
    const firstNormal = f32(faceSum(first).normalize());
    const secondNormal = f32(faceSum(second).normalize());

    writeFittedParts([part]);

    expect(readAttribute(part, 'NORMAL').getElement(1, [])).toEqual(firstNormal);
    expect(readAttribute(part, 'NORMAL').getElement(2, [])).toEqual(firstNormal);
    expect(readAttribute(part, 'NORMAL').getElement(3, [])).toEqual(secondNormal);
    expect(readAttribute(part, 'NORMAL').getElement(4, [])).toEqual(secondNormal);
  });

  it('re-orthogonalizes tangents against the new normal and preserves their handedness', () => {
    const part = fittedPart({
      local: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
      normals: [[0, 1, 0], [0, 1, 0], [0, 1, 0]],
      tangents: [[1, 0, 1, -1], [1, 0, 1, -1], [1, 0, 1, -1]],
      indices: [0, 1, 2],
    });
    part.points[1].add(new Vector3(0, 0, 0.25));
    const normal = faceSum(faceNormal(part.points[0], part.points[1], part.points[2])).normalize();
    const tangent = new Vector3(1, 0, 1)
      .addScaledVector(normal, -new Vector3(1, 0, 1).dot(normal)).normalize();

    writeFittedParts([part]);

    for (const i of [0, 1, 2]) {
      expect(readAttribute(part, 'TANGENT').getElement(i, [])).toEqual([...f32(tangent), -1]);
      expect(readAttribute(part, 'NORMAL').getElement(i, [])).toEqual(f32(normal));
    }
  });
});
