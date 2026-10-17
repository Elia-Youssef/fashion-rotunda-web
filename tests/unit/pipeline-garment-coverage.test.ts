import { Document } from '@gltf-transform/core';
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { fitCoveredSurface } from '../../pipeline/gltf/lib/garment-fit.mjs';
import {
  combinedSurface, createCoverage, faceSamples, measureSurface, surfaceParts, surfaceTopology,
} from '../../pipeline/gltf/lib/garment-coverage.mjs';

function part(geometry: BufferGeometry) {
  const p = geometry.getAttribute('position');
  return { points: Array.from({ length: p.count }, (_, i) => new Vector3().fromBufferAttribute(p, i)),
    indices: Array.from(geometry.getIndex()!.array), matrix: new Matrix4() };
}

/** An open box tube: four outward-wound sides, top and bottom are the two openings. */
function shell() {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([
    -1,-1,-1, 1,-1,-1, 1,1,-1, -1,1,-1,
    -1,-1,1, 1,-1,1, 1,1,1, -1,1,1,
  ], 3));
  g.setIndex([0,2,1,0,3,2, 4,5,6,4,6,7, 0,4,7,0,7,3, 1,2,6,1,6,5]);
  return g;
}

/** A lofted tube through rings of four corners; each ring closes, the ends stay open. */
function tube(rings: number[][][]) {
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

/** A document whose garment group holds the given meshes as children of one group node. */
function garmentDocument(meshes: number[][][], options: { translation?: [number, number, number]; meshless?: boolean } = {}) {
  const doc = new Document(), scene = doc.createScene(), buffer = doc.createBuffer();
  const group = doc.createNode('garment');
  scene.addChild(group);
  if (options.meshless) group.addChild(doc.createNode('spacer'));
  const meshNode = doc.createNode();
  if (options.translation) meshNode.setTranslation(options.translation);
  const mesh = doc.createMesh();
  for (const positions of meshes) {
    mesh.addPrimitive(doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setBuffer(buffer).setType('VEC3')
        .setArray(new Float32Array(positions.flat()))));
  }
  meshNode.setMesh(mesh);
  group.addChild(meshNode);
  return doc;
}

describe('garment surface extraction', () => {
  it('reads the garment group from every scene of the document', () => {
    const doc = new Document();
    doc.createScene().addChild(doc.createNode('mannequin'));
    const other = doc.createScene(), group = doc.createNode('garment');
    group.addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3')
        .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))))));
    other.addChild(group);
    const parts = surfaceParts(doc, 'garment');
    expect(parts).toHaveLength(1);
    expect(parts[0].points).toHaveLength(3);
  });

  it('extracts points in scene space through the node world matrix', () => {
    const doc = garmentDocument([[[0, 0, 0], [1, 0, 0], [0, 1, 0]]], { translation: [5, 0, 0] });
    const points = surfaceParts(doc, 'garment')[0].points.map((p) => p.toArray());
    expect(points).toEqual([[5, 0, 0], [6, 0, 0], [5, 1, 0]]);
  });

  it('skips meshless nodes and keeps every primitive of a node', () => {
    const doc = garmentDocument([[[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 0, 1], [1, 0, 1], [0, 1, 1]]],
      { meshless: true });
    const parts = surfaceParts(doc, 'garment');
    expect(parts).toHaveLength(2);
    expect(parts[1].points[0].z).toBe(1);
  });

  it('numbers faces sequentially when the primitive carries no indices', () => {
    const doc = garmentDocument([[[0, 0, 0], [1, 0, 0], [0, 1, 0]]]);
    expect(surfaceParts(doc, 'garment')[0].indices).toEqual([0, 1, 2]);
  });
});

describe('garment topology refusals', () => {
  it('refuses a shell with a degenerate face before any coverage query', () => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 2, 0, 0], 3));
    g.setIndex([0, 1, 2]);
    const topology = surfaceTopology(g);
    expect(topology.degenerateFaces).toBe(1);
    expect(topology.nonManifoldEdges).toBe(0);
    expect(topology.inconsistentEdges).toBe(0);
    expect(() => createCoverage(g, shell())).toThrow('invalid topology');
  });

  it('refuses a shell with a non-manifold edge and no other defect', () => {
    // A closed tetrahedron plus one reversed duplicate of a face: every edge of that face
    // is used three times, the surface keeps no boundary and no edge pair disagrees.
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute([
      0,0,0, 1,0,0, 0.5,1,0, 0.5,0.5,1,
    ], 3));
    g.setIndex([0,1,2, 0,3,1, 1,3,2, 2,3,0, 0,2,1]);
    const topology = surfaceTopology(g);
    expect(topology.nonManifoldEdges).toBe(3);
    expect(topology.inconsistentEdges).toBe(0);
    expect(topology.degenerateFaces).toBe(0);
    expect(topology.loops).toHaveLength(0);
    expect(() => createCoverage(g, shell())).toThrow('invalid topology');
  });

  it('refuses a shell whose boundary loop is open', () => {
    // Two triangles sharing one corner weld to a single vertex with four boundary
    // neighbours, so the one boundary walk never closes into a ring.
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute([
      0,0,0, 1,0,0, 0,1,0, 0,-1,0, -1,0,0,
    ], 3));
    g.setIndex([0, 1, 2, 0, 3, 4]);
    const topology = surfaceTopology(g);
    expect(topology.loops).toHaveLength(1);
    expect(topology.loops[0].closed).toBe(false);
    expect(topology.nonManifoldEdges).toBe(0);
    expect(topology.inconsistentEdges).toBe(0);
    expect(() => createCoverage(g, shell())).toThrow('invalid topology');
  });

  it('welds seam vertices inside the one-micrometre grid cell', () => {
    const g = shell().toNonIndexed();
    g.setIndex(Array.from({ length: g.getAttribute('position').count }, (_, i) => i));
    const positions = g.getAttribute('position');
    // 0.3 micrometres along x stays inside the same one-micrometre cell as the corner.
    positions.setX(0, positions.getX(0) + 0.0000003);
    const topology = surfaceTopology(g);
    expect(topology.loops).toHaveLength(2);
    expect(topology.degenerateFaces).toBe(0);
    expect(topology.nonManifoldEdges).toBe(0);
    expect(topology.inconsistentEdges).toBe(0);
    expect(() => createCoverage(g, new BufferGeometry().copy(shell()))).not.toThrow();
  });
});

describe('section centres', () => {
  it('returns null outside the garment heights and interpolates inside', () => {
    const coverage = createCoverage(shell(), combinedSurface([part(new BufferGeometry().copy(shell()))]));
    expect(coverage.centerAt(2)).toBeNull();
    expect(coverage.centerAt(-2)).toBeNull();
    const middle = coverage.centerAt(0);
    expect(middle).not.toBeNull();
    expect(middle!.y).toBeCloseTo(0, 9);
  });

  it('brackets a non-linear centre track between neighbouring sections', () => {
    // The middle ring is offset to the other side, so the centre track bends: the
    // halfway centre is the average of its two bracketing sections, not of the ends.
    const hourglass = tube([
      [[0,-1,0],[2,-1,0],[2,-1,2],[0,-1,2]],
      [[-1,0,-1],[1,0,-1],[1,0,1],[-1,0,1]],
      [[0,1,0],[2,1,0],[2,1,2],[0,1,2]],
    ]);
    const coverage = createCoverage(hourglass, combinedSurface([part(shell())]));
    const upper = coverage.centerAt(0.5)!, lower = coverage.centerAt(-0.5)!;
    expect(upper.x).toBeCloseTo(0.5, 6);
    expect(upper.y).toBeCloseTo(0.5, 6);
    expect(lower.x).toBeCloseTo(0.5, 6);
    expect(lower.y).toBeCloseTo(-0.5, 6);
  });

  it('limits each section to the edges crossing its height', () => {
    // The two rings sit far apart along x, so the mid-height section averages them;
    // a section that also counted the non-crossing rings would centre elsewhere.
    const leaning = tube([
      [[0,-1,0],[2,-1,0],[2,-1,2],[0,-1,2]],
      [[10,1,0],[14,1,0],[14,1,2],[10,1,2]],
    ]);
    const coverage = createCoverage(leaning, combinedSurface([part(shell())]));
    const centre = coverage.centerAt(0)!;
    expect(centre.x).toBeCloseTo(6.5, 3);
    expect(centre.z).toBeCloseTo(1, 3);
  });
});

describe('radial coverage queries', () => {
  it('never covers a body point below the garment openings', () => {
    const torso = part(new BoxGeometry(1.2, 2.0, 1.2).translate(0, -0.2, 0));
    const foot = part(new BoxGeometry(0.4, 0.4, 0.4).translate(0, -1.4, 0));
    const coverage = createCoverage(shell(), combinedSurface([torso, foot]));
    expect(measureSurface([foot], coverage).coveredSamples).toBe(0);
    expect(measureSurface([torso], coverage).coveredSamples).toBeGreaterThan(0);
  });

  it('probes radially in the horizontal plane from the section centre', () => {
    const coverage = createCoverage(shell(), combinedSurface([part(new BoxGeometry(2.04, 1.6, 1.2))]));
    const q = coverage.query(new Vector3(1.02, 0.1, 0))!;
    expect(q.direction.y).toBe(0);
    expect(q.center.y).toBeCloseTo(0.1, 12);
    expect(q.radius).toBeCloseTo(1.02, 6);
  });

  it('covers a body sample within ten millimetres of the section axis', () => {
    const rod = [part(new BoxGeometry(0.01, 1.6, 0.01))];
    const coverage = createCoverage(shell(), combinedSurface(rod));
    expect(measureSurface(rod, coverage).coveredSamples).toBeGreaterThan(0);
  });

  it('returns null for a direction through a garment opening', () => {
    const opened = shell();
    const index = opened.getIndex()!;
    opened.setIndex(Array.from(index.array).slice(0, index.count - 6));
    const coverage = createCoverage(opened, combinedSurface([part(new BoxGeometry(2.2, 1.6, 1.2))]));
    expect(() => coverage.query(new Vector3(1.1, 0, 0))).not.toThrow();
    expect(coverage.query(new Vector3(1.1, 0, 0))).toBeNull();
  });

  it('returns null when the first garment hit faces against the probe', () => {
    // Two closed boxes leave a gap at the section centre: a probe toward one box meets
    // its inward-facing wall first, which is an entry, never a covered exit.
    const garment = combinedSurface([part(new BoxGeometry(2, 2, 0.6).translate(0, 0, -0.7)),
      part(new BoxGeometry(2, 2, 0.6).translate(0, 0, 0.7))]);
    const coverage = createCoverage(garment, combinedSurface([part(new BoxGeometry(1.0, 1.6, 0.8))]));
    expect(() => coverage.query(new Vector3(0, 0, 0.4))).not.toThrow();
    expect(coverage.query(new Vector3(0, 0, 0.4))).toBeNull();
  });

  it('covers the far surface of a body that starts beyond the probe origin', () => {
    // The ray meets this body's entry before its exit; the exit face is still the
    // covered interval boundary, not an intersecting interval.
    const body = [part(new BoxGeometry(0.4, 0.4, 0.4).translate(0.7, 0, 0))];
    const coverage = createCoverage(shell(), combinedSurface(body));
    expect(coverage.query(new Vector3(0.9, 0, 0))).not.toBeNull();
  });

  it('returns null when the only body hit faces against the ray', () => {
    // One triangle whose normal points along +x, so the -x probe meets it entry-facing
    // only: without an exit-facing body hit the direction is not a covered interval.
    const plate = new BufferGeometry();
    plate.setAttribute('position', new Float32BufferAttribute([
      -0.5,-0.5,0, -0.5,0.5,0, -0.5,0,0.8,
    ], 3));
    plate.setIndex([0, 1, 2]);
    const coverage = createCoverage(shell(), plate);
    expect(() => coverage.query(new Vector3(-0.5, 0, 0.2667))).not.toThrow();
    expect(coverage.query(new Vector3(-0.5, 0, 0.2667))).toBeNull();
  });

  it('covers a crossing limb while a nearer separate limb stays exposed', () => {
    const near = part(new BoxGeometry(1.0, 1.2, 1.2).translate(-0.1, 0, 0));
    const gap = part(new BoxGeometry(0.1, 0.4, 0.4).translate(0.55, 0, 0));
    const crossing = part(new BoxGeometry(0.4, 0.4, 0.4).translate(1.0, 0, 0));
    const coverage = createCoverage(shell(), combinedSurface([near, gap, crossing]),
      null, { includeIntersectingIntervals: true });
    expect(measureSurface([gap], coverage).coveredSamples).toBe(0);
    expect(measureSurface([crossing], coverage).coveredSamples).toBeGreaterThan(0);
  });

  it('excludes a point the reference coverage excludes', () => {
    const torso = part(new BoxGeometry(1.2, 1.6, 1.2));
    const limb = part(new BoxGeometry(0.2, 0.4, 0.2).translate(1.6, 0, 0));
    const body = combinedSurface([torso, limb]);
    const reference = createCoverage(shell(), body);
    const tested = createCoverage(shell(), body, reference);
    expect(tested.query(new Vector3(0.6, 0, 0))).not.toBeNull();
    expect(() => tested.query(limb.points[0])).not.toThrow();
    expect(tested.query(limb.points[0])).toBeNull();
  });

  it('reports shell radius and depth in reference mode', () => {
    const body = combinedSurface([part(new BoxGeometry(2.04, 1.6, 1.2))]);
    const tested = createCoverage(shell(), body, createCoverage(shell(), body));
    const q = tested.query(new Vector3(1.02, 0, 0))!;
    expect(q.shellRadius).toBeCloseTo(1.0, 6);
    expect(q.depth).toBeCloseTo(0.02, 6);
  });

  it('reports the nearest opening distance and the shell hit', () => {
    const coverage = createCoverage(shell(), combinedSurface([part(new BoxGeometry(2.04, 1.6, 1.2))]));
    const q = coverage.query(new Vector3(1.02, 0, 0))!;
    expect(q.openingDistance).toBeCloseTo(1.0, 6);
    expect(q.point.x).toBeCloseTo(1.0, 6);
    expect(q.point.y).toBeCloseTo(0, 6);
    const garmentParts = [part(shell())];
    const triangle = garmentParts[0].indices.slice(q.faceIndex * 3, q.faceIndex * 3 + 3);
    expect(triangle.every((j) => garmentParts[0].points[j].x > 0.5)).toBe(true);
  });

  it('exposes shell radii and null beyond the garment heights', () => {
    const coverage = createCoverage(shell(), combinedSurface([part(new BoxGeometry(2.04, 1.6, 1.2))]));
    expect(coverage.shellRadiusAt(new Vector3(2, 0, 0))).toBeCloseTo(1.0, 6);
    expect(coverage.shellRadiusAt(new Vector3(0.5, 5, 0))).toBeNull();
  });

  it('carries the caller options on the coverage object', () => {
    const coverage = createCoverage(shell(), combinedSurface([part(shell())]),
      null, { includeIntersectingIntervals: true });
    expect(coverage.options).toEqual({ includeIntersectingIntervals: true });
  });
});

describe('surface sampling and measurement', () => {
  it('samples corners, edge midpoints and the centroid of a triangle', () => {
    const samples = faceSamples(new Vector3(0, 0, 0), new Vector3(1, 0, 0), new Vector3(0, 1, 0));
    expect(samples).toHaveLength(7);
    const expected = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0.5, 0, 0], [0.5, 0.5, 0], [0, 0.5, 0], [1 / 3, 1 / 3, 0]];
    for (const [i, sample] of samples.entries()) {
      for (const [j, value] of sample.toArray().entries()) expect(value).toBeCloseTo(expected[i][j], 12);
    }
  });

  it('counts faces and unique covered samples without repeats', () => {
    // A box carries 8 corner positions, 18 edge and diagonal midpoints and 12 face
    // centroids: 38 unique samples for 84 triangle samples, each queried once.
    const body = [part(new BoxGeometry(1.9, 1.5, 1.1))];
    const measurement = measureSurface(body, createCoverage(shell(), combinedSurface(body)));
    expect(measurement.totalFaces).toBe(12);
    expect(measurement.uniqueSamples).toBe(38);
    expect(measurement.coveredSamples).toBeGreaterThan(0);
    expect(measurement.outsideSamples).toBe(0);
  });

  it('counts penetrating faces, bands and millimetre depths', () => {
    const coverage = createCoverage(shell(), combinedSurface([part(new BoxGeometry(2.04, 1.6, 1.2))]));
    const body = [part(new BoxGeometry(2.04, 1.6, 1.2))];
    const measurement = measureSurface(body, coverage);
    expect(measurement.penetratingFaces).toBeGreaterThan(0);
    expect(measurement.outsideSamples).toBeGreaterThan(0);
    expect(measurement.penetrations).toHaveLength(measurement.outsideSamples);
    expect(Object.keys(measurement.bands)).toContain('0.8');
    expect(measurement.bands['0.8']!.covered).toBeGreaterThan(0);
    expect(measurement.bands['0.0']!.outside).toBeGreaterThan(0);
    expect(measurement.bands['0.0']!.depthsMm.length).toBeGreaterThan(0);
    expect(measurement.penetrations.every((s) => s.depthMm > 5 && s.depthMm < 50)).toBe(true);
  });

  it('clears penetration to the fit margin', () => {
    const body = [part(new BoxGeometry(2.2, 1.6, 1.2))];
    const result = fitCoveredSurface([part(shell())], body, 'body-inward');
    expect(result.movedVertices).toBeGreaterThan(0);
    // Every corner travels its own radial depth of 0.1139 m plus the one-millimetre
    // margin, so the largest displacement is 0.1149 m, 114.9 millimetres.
    expect(result.maxDisplacementMm).toBeCloseTo(114.88, 1);
  });
});
