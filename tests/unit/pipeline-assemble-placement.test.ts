import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Document, NodeIO, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assemble } from '../../pipeline/gltf/assemble.mjs';
import { GARMENT_PLACEMENTS } from '../../pipeline/gltf/lib/garment-placement.mjs';

const LOOK_SLUGS = ['wallis-dress', 'zoot-suit', 'new-look-dress', 'mondrian-dress',
  'jumpsuit-dress', 'blue-silk-dress', 'geoffrey-beene'];
const HAT_FILE = 'SM_ZootSuit_Hat.glb';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
let directory: string;

beforeEach(async () => {
  directory = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-placement-'));
  const document = new Document();
  const buffer = document.createBuffer();
  // Representative exported hat extrema, metres, before any placement or plinth offset.
  const positions = document.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([-1.47, 17.88, -2.22, 1.61, 19.79, 1, 0, 18, 0]));
  const material = document.createMaterial('fabric');
  const mesh = document.createMesh().addPrimitive(document.createPrimitive()
    .setAttribute('POSITION', positions).setMaterial(material));
  document.createScene().addChild(document.createNode('exported-mesh').setMesh(mesh));
  await io.write(resolve(directory, HAT_FILE), document);
  document.getRoot().listNodes()[0].setTranslation([0.2, 0.3, 0.4]).setScale([2, 3, 4]);
  await io.write(resolve(directory, 'other.glb'), document);
  writeFileSync(resolve(directory, 'catalog-source.json'), JSON.stringify({
    rotunda: { file: 'other.glb' },
    plinth: { file: 'other.glb' },
    looks: LOOK_SLUGS.map((slug) => ({
      slug,
      name: slug,
      garments: [{ file: 'other.glb' }, { file: HAT_FILE }, { file: 'other.glb' }],
      mannequin: { file: 'other.glb' },
      swatches: {},
    })),
  }));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

async function assembled(slug: string) {
  const out = resolve(directory, 'out');
  mkdirSync(out, { recursive: true });
  await assemble({ only: slug, exportRoot: directory, out, log: () => {} });
  return io.read(resolve(out, `looks/${slug}.glb`));
}

function group(document: Document, name: string): Node {
  return document.getRoot().listNodes().find((node) => node.getName() === name)!;
}

describe('garment placement during assembly', () => {
  it('records the accepted hat scale and translation under its look and source filename', () => {
    expect(GARMENT_PLACEMENTS).toEqual({
      'zoot-suit': {
        'SM_ZootSuit_Hat.glb': {
          scale: [0.1, 0.1, 0.1],
          translation: [-0.01, 0, 0.025],
        },
      },
    });
  });

  it('applies translate times scale to the hat group and preserves every other local transform', async () => {
    const document = await assembled('zoot-suit');
    const hat = group(document, 'garment-1');
    expect(hat.getWorldMatrix()).toEqual([
      0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0, -0.01, 0, 0.025, 1,
    ]);
    for (const name of ['garment', 'garment-2', 'mannequin']) {
      const node = group(document, name);
      expect(node.getTranslation()).toEqual([0, 0, 0]);
      expect(node.getScale()).toEqual([1, 1, 1]);
      expect(node.getRotation()).toEqual([0, 0, 0, 1]);
      expect(node.listChildren()[0].getTranslation()).toEqual([0.2, 0.3, 0.4]);
      expect(node.listChildren()[0].getScale()).toEqual([2, 3, 4]);
      expect(node.listChildren()[0].getRotation()).toEqual([0, 0, 0, 1]);
    }
    expect(hat.listChildren()[0].getTranslation()).toEqual([0, 0, 0]);
    expect(hat.listChildren()[0].getScale()).toEqual([1, 1, 1]);
    expect(hat.listChildren()[0].getRotation()).toEqual([0, 0, 0, 1]);
  });

  it('leaves an unlisted look unchanged even with the same garment source filename', async () => {
    const document = await assembled('wallis-dress');
    for (const name of ['garment', 'garment-1', 'garment-2', 'mannequin']) {
      const node = group(document, name);
      expect(node.getTranslation()).toEqual([0, 0, 0]);
      expect(node.getScale()).toEqual([1, 1, 1]);
      expect(node.getRotation()).toEqual([0, 0, 0, 1]);
      const source = await io.read(resolve(directory, name === 'garment-1' ? HAT_FILE : 'other.glb'));
      expect(node.listChildren()[0].getMatrix()).toEqual(source.getRoot().listNodes()[0].getMatrix());
    }
  });

  it('places the hat bounds at head height with the accepted horizontal offsets', async () => {
    const document = await assembled('zoot-suit');
    const bounds = getBounds(group(document, 'garment-1'));
    expect(bounds.min[1]).toBeCloseTo(1.788, 5);
    expect(bounds.max[1]).toBeCloseTo(1.979, 5);
    expect(bounds.max[0] - bounds.min[0]).toBeCloseTo(0.308, 5);
    expect(bounds.min[0]).toBeCloseTo(-0.157, 5);
    expect(bounds.max[0]).toBeCloseTo(0.151, 5);
    expect(bounds.min[2]).toBeCloseTo(-0.197, 5);
    expect(bounds.max[2]).toBeCloseTo(0.125, 5);
  });
});
