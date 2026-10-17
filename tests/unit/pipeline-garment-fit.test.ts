import { Document } from '@gltf-transform/core';
import { KHRMaterialsVariants } from '@gltf-transform/extensions';
import type { MappingList } from '@gltf-transform/extensions';
import { cloneDocument } from '@gltf-transform/functions';
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { applyLookFit, fitCoveredSurface, validateFitOutput } from '../../pipeline/gltf/lib/garment-fit.mjs';
import { writeFittedParts } from '../../pipeline/gltf/lib/garment-attributes.mjs';
import { combinedSurface, CONTACT_TOLERANCE, createCoverage, FIT_MARGIN, measureSurface, surfaceParts, surfaceTopology } from '../../pipeline/gltf/lib/garment-coverage.mjs';

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

/**
 * A pyramid whose only penetrating sample is its apex, listed first in every side face: the
 * apex pokes five centimetres past the shell while its base stays deep inside.
 */
function pyramid() {
  const g = new BufferGeometry();
  const base = [[0.5, -0.15, -0.15], [0.5, 0.15, -0.15], [0.5, 0.15, 0.15], [0.5, -0.15, 0.15]];
  g.setAttribute('position', new Float32BufferAttribute([1.05, 0, 0, ...base.flat()], 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 1, 3, 2, 1, 4, 3]);
  return g;
}

/**
 * The same pyramid sunk five centimetres into the shell wall, so its apex, edge midpoints,
 * centroid and base all penetrate at different depths on every side face.
 */
function sunkenPyramid() {
  const g = new BufferGeometry();
  const base = [[1.002, -0.15, -0.15], [1.002, 0.15, -0.15], [1.002, 0.15, 0.15], [1.002, -0.15, 0.15]];
  g.setAttribute('position', new Float32BufferAttribute([1.05, 0, 0, ...base.flat()], 3));
  g.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 1, 3, 2, 1, 4, 3]);
  return g;
}

/**
 * A box whose top near corner belongs only to the second triangle of each of its three
 * incident faces, so a sampler that skips alternate triangles never lists that corner.
 */
function lopsidedBox() {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([
    -1.1,-0.8,-0.6, 1.1,-0.8,-0.6, 1.1,0.8,-0.6, -1.1,0.8,-0.6,
    -1.1,-0.8,0.6, 1.1,-0.8,0.6, 1.1,0.8,0.6, -1.1,0.8,0.6,
  ], 3));
  g.setIndex([
    5,1,2, 5,2,6,
    2,3,7, 2,7,6,
    7,4,5, 7,5,6,
    0,4,7, 0,7,3,
    0,1,5, 0,5,4,
    1,0,3, 1,3,2,
  ]);
  return g;
}

/** A document whose garment and mannequin groups hold one static indexed primitive each. */
function partsDocument(garment: BufferGeometry, bodies: BufferGeometry[]) {
  const doc = new Document(), scene = doc.createScene(), buffer = doc.createBuffer();
  const add = (name: string, geometry: BufferGeometry, withNormals: boolean) => {
    const primitive = doc.createPrimitive().setAttribute('POSITION', doc.createAccessor().setBuffer(buffer)
      .setType('VEC3').setArray(new Float32Array(geometry.getAttribute('position').array)));
    if (withNormals) {
      primitive.setAttribute('NORMAL', doc.createAccessor().setBuffer(buffer).setType('VEC3')
        .setArray(new Float32Array(geometry.getAttribute('normal')!.array)));
    }
    primitive.setIndices(doc.createAccessor().setBuffer(buffer).setType('SCALAR')
      .setArray(new Uint32Array(geometry.getIndex()!.array)));
    const group = doc.createNode(name);
    group.addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)));
    scene.addChild(group);
  };
  add('garment', garment, false);
  for (const geometry of bodies) add('mannequin', geometry, true);
  return doc;
}

function contactDocument() {
  return partsDocument(shell(), [body()]);
}

/** A garment of two crossing squares over a mannequin whose vertices probe no square. */
function selfIntersectingDocument() {
  const doc = new Document(), scene = doc.createScene(), buffer = doc.createBuffer();
  const square = (points: number[]) => {
    const primitive = doc.createPrimitive().setAttribute('POSITION', doc.createAccessor().setBuffer(buffer)
      .setType('VEC3').setArray(new Float32Array(points)));
    primitive.setIndices(doc.createAccessor().setBuffer(buffer).setType('SCALAR')
      .setArray(new Uint32Array([0, 1, 2, 0, 2, 3])));
    return primitive;
  };
  const mesh = doc.createMesh();
  mesh.addPrimitive(square([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5]));
  mesh.addPrimitive(square([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]));
  const garment = doc.createNode('garment');
  garment.addChild(doc.createNode().setMesh(mesh));
  scene.addChild(garment);
  scene.addChild(mannequinGroup(doc, buffer));
  return doc;
}

function mannequinGroup(doc: Document, buffer: ReturnType<Document['createBuffer']>) {
  const geometry = body();
  const primitive = doc.createPrimitive();
  for (const [field, attribute] of [['POSITION', 'position'], ['NORMAL', 'normal']] as const) {
    primitive.setAttribute(field, doc.createAccessor().setBuffer(buffer).setType('VEC3')
      .setArray(new Float32Array(geometry.getAttribute(attribute)!.array)));
  }
  primitive.setIndices(doc.createAccessor().setBuffer(buffer).setType('SCALAR')
    .setArray(new Uint32Array(geometry.getIndex()!.array)));
  const group = doc.createNode('mannequin');
  group.addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(primitive)));
  return group;
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

describe('covered surface fitting defaults', () => {
  it('fits the garment outward when the caller names no method and leaves the body exact', () => {
    const garment = [part(shell())], mannequin = [part(body())];
    const before = mannequin[0].points.map((p) => p.toArray());
    const result = fitCoveredSurface(garment, mannequin);
    expect(mannequin[0].points.map((p) => p.toArray())).toEqual(before);
    expect(result.movedVertices).toBeGreaterThan(0);
    const fitted = createCoverage(combinedSurface(garment), combinedSurface(mannequin));
    expect(measureSurface(mannequin, fitted).outsideSamples).toBe(0);
  });

  it('corrects the deepest sample by at least its depth plus the fit margin', () => {
    const garment = [part(shell())], mannequin = [part(body())];
    const measured = measureSurface(mannequin, createCoverage(combinedSurface(garment), combinedSurface(mannequin)));
    const deepest = Math.max(...measured.penetrations.map((sample) => sample.depthMm));
    const result = fitCoveredSurface(garment, mannequin, 'garment-outward');
    expect(result.maxDisplacementMm).toBeGreaterThanOrEqual(deepest + FIT_MARGIN * 1000 - 0.001);
    expect(result.history[0].maxDepthMm).toBeCloseTo(deepest, 6);
    expect(result.history.at(-1)!.maxDepthMm).toBe(0);
    // Every vertex receives its greatest proposal at once, so this fixture resolves in an
    // initial measurement plus three correction rounds; smaller proposals need a fourth.
    expect(result.history).toHaveLength(4);
  });

  it('proposes no correction while every sample stays within the contact tolerance', () => {
    const garment = [part(shell())], mannequin = [part(new BoxGeometry(2.0001, 1.6, 1.2))];
    const result = fitCoveredSurface(garment, mannequin, 'body-inward');
    expect(result.movedVertices).toBe(0);
    expect(result.maxDisplacementMm).toBe(0);
  });

  it('leaves every penetrating corner clear of the shell by the fit margin', () => {
    const garment = [part(shell())], mannequin = [part(body())];
    const before = createCoverage(combinedSurface(garment), combinedSurface(mannequin));
    const penetrating = mannequin[0].points
      .filter((point) => (before.query(point)?.depth ?? 0) > CONTACT_TOLERANCE);
    expect(penetrating.length).toBeGreaterThan(0);
    fitCoveredSurface(garment, mannequin, 'body-inward');
    const after = createCoverage(combinedSurface(garment), combinedSurface(mannequin));
    for (const point of penetrating) {
      expect(after.query(point)!.depth).toBeLessThanOrEqual(-FIT_MARGIN + 0.000000001);
    }
  });

  it('corrects every corner of a penetrating face by the deepest correction available to it', () => {
    const garment = [part(shell())], sunk = [part(sunkenPyramid())];
    const before = sunk[0].points.map((p) => p.clone());
    const measured = measureSurface(sunk, createCoverage(combinedSurface(garment), combinedSurface(sunk)));
    const deepest = Math.max(...measured.penetrations.map((sample) => sample.depthMm));
    const result = fitCoveredSurface(garment, sunk, 'body-inward');
    expect(result.history).toHaveLength(2);
    for (const [i, point] of sunk[0].points.entries()) {
      expect(point.distanceTo(before[i]) * 1000).toBeGreaterThanOrEqual(deepest + FIT_MARGIN * 1000 - 0.001);
    }
    const cleared = createCoverage(combinedSurface(garment), combinedSurface(sunk));
    expect(measureSurface(sunk, cleared).outsideSamples).toBe(0);
  });
});

describe('covered surface fitting coverage and budget', () => {
  it('spends the full documented pass budget before refusing a fit that cannot converge', () => {
    let message: string | null = null;
    try {
      fitCoveredSurface([part(pinchedTube())], [part(body())], 'body-inward');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message?.startsWith('Garment fit did not converge')).toBe(true);
    const history = JSON.parse(message!.replace('Garment fit did not converge: ', '')) as { pass: number }[];
    // The refusal records the initial measurement plus the 64 advancing passes.
    expect(history).toHaveLength(65);
    expect(history[0].pass).toBe(0);
    expect(history[64].pass).toBe(64);
  });

  it('weighs every sample of a triangle, first corner included, when proposing corrections', () => {
    const garment = [part(shell())], spike = [part(pyramid())];
    const result = fitCoveredSurface(garment, spike, 'body-inward');
    expect(result.movedVertices).toBeGreaterThan(0);
    const cleared = createCoverage(combinedSurface(garment), combinedSurface(spike));
    expect(measureSurface(spike, cleared).outsideSamples).toBe(0);
  });

  it('samples every body triangle so a corner no other triangle lists still clears the shell', () => {
    const garment = [part(shell())], lopsided = [part(lopsidedBox())];
    fitCoveredSurface(garment, lopsided, 'body-inward');
    const cleared = createCoverage(combinedSurface(garment), combinedSurface(lopsided));
    expect(measureSurface(lopsided, cleared).outsideSamples).toBe(0);
  });

  it('maps a hit face that lives in a later garment part through the face walk', () => {
    const garment = [part(new BoxGeometry(0.2, 0.2, 0.2).translate(0, 10, 0)), part(shell())];
    const mannequin = [part(body())];
    const result = fitCoveredSurface(garment, mannequin, 'garment-outward');
    expect(result.movedVertices).toBeGreaterThan(0);
    const cleared = createCoverage(combinedSurface(garment), combinedSurface(mannequin));
    expect(measureSurface(mannequin, cleared).outsideSamples).toBe(0);
  });
});

describe('serialized fit validation', () => {
  it('returns the contact measurement fields for a fitted policy look', () => {
    const doc = contactDocument();
    const fit = applyLookFit(doc, 'mondrian-dress');
    expect(fit).toMatchObject({ applied: true, method: 'contact-clearance' });
    const validated = validateFitOutput(doc, fit);
    expect(validated).toMatchObject({ checked: true, outsideVertices: 0 });
    expect(validated).toHaveProperty('uniqueVertices');
  }, 20_000);

  it('refuses a serialized garment that intersects itself before measuring contacts', () => {
    const fit = applyLookFit(contactDocument(), 'mondrian-dress');
    expect(() => validateFitOutput(selfIntersectingDocument(), fit)).toThrow('Garment self-intersection');
  }, 20_000);

  it('validates a covered-surface fit against the coverage policy the fit was given', () => {
    const doc = partsDocument(shell(),
      [new BoxGeometry(1.2, 1.6, 1.2), new BoxGeometry(0.4, 0.4, 0.4).translate(1, 0, 0)]);
    const garmentParts = surfaceParts(doc, 'garment'), bodyParts = surfaceParts(doc, 'mannequin');
    const originals = bodyParts.map((bodyPart) =>
      Float32Array.from(bodyPart.primitive.getAttribute('POSITION')!.getArray()!));
    const fit = { applied: true as const, method: 'body-inward' as const,
      ...fitCoveredSurface(garmentParts, bodyParts, 'body-inward', { includeIntersectingIntervals: true }) };
    writeFittedParts(bodyParts);
    expect(validateFitOutput(doc, fit)).toMatchObject({ checked: true, outsideSamples: 0 });
    bodyParts.forEach((bodyPart, i) => bodyPart.primitive.getAttribute('POSITION')!.setArray(originals[i]));
    expect(() => validateFitOutput(doc, fit)).toThrow('Serialized garment fit failed');
  });
});
