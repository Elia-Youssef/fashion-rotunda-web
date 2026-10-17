import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { assertNoSurfaceIntersections } from '../../pipeline/gltf/lib/garment-intersection.mjs';

interface SurfacePart {
  points: Vector3[];
  indices: number[];
}

function surfacePart(points: number[][], indices: number[]): SurfacePart {
  return { points: points.map((v) => new Vector3(...v)), indices };
}

/** Two triangles sharing edge (b, c), folded or coplanar: touching only along that edge. */
function edgePair(offset: number[], fold: number): { local: number[][], indices: number[] } {
  const [x, y, z] = offset;
  return {
    local: [
      [x, y, z], [x + 1, y, z], [x, y + 1, z], [x + 1, y + 1, z + fold],
    ],
    indices: [0, 1, 2, 1, 3, 2],
  };
}

describe('garment surface intersection check', () => {
  it('resolves a shell of disjoint, folded and coplanar neighbors', () => {
    const folded = edgePair([0, 0, 20], 1), coplanar = edgePair([0, 0, 40], 0);
    const part = surfacePart(
      [
        [0, 0, 0], [1, 0, 0], [0, 1, 0],
        [0, 0, 5], [1, 0, 5], [0, 1, 5],
        [0.5, 0.5, 5.6], [1.5, 0.5, 5.6], [0.5, 1.5, 5.6],
        ...folded.local, ...coplanar.local,
      ],
      [
        0, 1, 2, 3, 4, 5,
        ...folded.indices.map((i) => i + 9),
        ...coplanar.indices.map((i) => i + 13),
      ],
    );
    expect(() => assertNoSurfaceIntersections([part])).not.toThrow();
  });

  it('reports the first crossing pair the scan reaches', () => {
    // Two independent crossings: the reported pair is the first one the scan reaches.
    const part = surfacePart([
      [0, 0, 0], [4, 0, 0], [0, 4, 0],
      [1, 1, -1], [2, 2, 1], [3, 1, -1],
      [0, 0, 5], [4, 0, 5], [0, 4, 5],
      [1, 1, 4], [2, 2, 6], [3, 1, 4],
    ], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(() => assertNoSurfaceIntersections([part]))
      .toThrow('Garment self-intersection between faces 0 and 1');
  });

  it('keeps scan labels aligned with the welded surface topology', () => {
    // Folded neighbor pairs interleaved and spread far apart, so a BVH that relabels
    // triangles stops excluding the touching neighbors and reports a false crossing.
    const points: number[][] = [], indices: number[] = [];
    const offsets = [[0, 0, 0], [180, 40, 0], [60, 120, 0], [120, 80, 0]];
    for (const [k, offset] of offsets.entries()) {
      const pair = edgePair(offset, 1);
      points.push(...pair.local);
      indices.push(...pair.indices.map((i) => i + 4 * k));
    }
    expect(() => assertNoSurfaceIntersections([surfacePart(points, indices)])).not.toThrow();
  });
});
