import * as fs from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { Accessor, Document, NodeIO, Primitive as GltfPrimitive } from '@gltf-transform/core';
import type { Mesh, Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshGPUInstancing } from '@gltf-transform/extensions';
import { BufferAttribute, BufferGeometry, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error The standalone JavaScript builder has no TypeScript declaration.
import { writeCollision as writeCollisionScript } from '../../pipeline/gltf/collision.mjs';
import { resolveCapsule } from '../../src/camera/collide';

const writeCollision: (out?: string) => Promise<{ triangles: number; bytes: number }> = writeCollisionScript;
const paths = vi.hoisted(() => ({ out: '', content: '' }));

// Keep default reads and writes inside the fixture, including during broken-code checks.
vi.mock('../../pipeline/config.mjs', () => ({ get contentDir() { return paths.content; } }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  function guard(target: fs.PathLike) {
    const child = relative(paths.out, String(target));
    if (isAbsolute(child) || child === '..' || child.startsWith('../') || child.startsWith('..\\')) {
      throw new Error(`write outside fixture output: ${String(target)}`);
    }
  }
  return {
    ...actual,
    mkdirSync: vi.fn((target: fs.PathLike, options: fs.MakeDirectoryOptions) => {
      guard(target);
      return actual.mkdirSync(target, options);
    }),
    writeFileSync: vi.fn((target: fs.PathLike, bytes: Uint8Array) => {
      guard(target);
      return actual.writeFileSync(target, bytes);
    }),
  };
});

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
// Non-degenerate triangles, separated in X so filtering cannot hide behind overlapping geometry.
const TRIANGLE = [0, 0, 0, 1, 0, 0, 0, 1, 0];
let sandbox = '';

function triangle(document: Document, name: string, x = 0): Mesh {
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer();
  const positions = document.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array(TRIANGLE.map((value, index) => value + (index % 3 === 0 ? x : 0))));
  const indices = document.createAccessor().setType('SCALAR').setBuffer(buffer)
    .setArray(new Uint16Array([0, 1, 2]));
  return document.createMesh(name).addPrimitive(
    document.createPrimitive().setAttribute('POSITION', positions).setIndices(indices),
  );
}

function scene(names: string[]): Document {
  const document = new Document();
  const rootScene = document.createScene();
  names.forEach((name, index) => {
    rootScene.addChild(document.createNode().setMesh(triangle(document, name, index * 10)));
  });
  document.getRoot().setDefaultScene(rootScene);
  return document;
}

async function inputs(rotunda: Document, plinth = scene(['Plinth'])) {
  await io.write(resolve(paths.out, 'rotunda.glb'), rotunda);
  await io.write(resolve(paths.out, 'plinth.glb'), plinth);
}

function signatures(primitive: Primitive): string[] {
  const positions = primitive.getAttribute('POSITION')!;
  const indices = primitive.getIndices()!;
  const triangles: string[] = [];
  for (let index = 0; index < indices.getCount(); index += 3) {
    const vertices: string[] = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = indices.getScalar(index + corner);
      vertices.push(positions.getElement(vertex, [] as number[])
        .map((value) => Number(value.toFixed(5))).join(','));
    }
    triangles.push(vertices.sort().join('|'));
  }
  return triangles.sort();
}

function expectedTriangles(triangles: number[][]): string[] {
  return triangles.map((values) => [0, 3, 6].map((offset) => values.slice(offset, offset + 3).join(','))
    .sort().join('|')).sort();
}

async function output() {
  const document = await io.read(resolve(paths.out, 'collision.glb'));
  return { document, primitive: document.getRoot().listMeshes()[0]!.listPrimitives()[0]! };
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await snapshot(path);
      for (const [name, bytes] of Object.entries(nested)) files[`${entry.name}/${name}`] = bytes;
    } else {
      files[entry.name] = (await readFile(path)).toString('hex');
    }
  }
  return files;
}

beforeEach(async () => {
  sandbox = await mkdtemp(resolve(tmpdir(), 'collision-test-'));
  paths.out = resolve(sandbox, 'custom-output');
  paths.content = resolve(sandbox, 'default-content');
  await mkdir(paths.out);
  await mkdir(paths.content);
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Only the absolute mkdtemp result under the OS temp directory is removed.
  if (!sandbox.startsWith(resolve(tmpdir(), 'collision-test-'))) throw new Error('invalid fixture directory');
  await rm(sandbox, { recursive: true, force: true });
});

describe('writeCollision', () => {
  it('keeps walls, floors, columns and plinth but drops dome and beams by mesh name', async () => {
    const rotunda = scene(['Wall', 'Floor', 'Column', 'WallAbove3m', 'SM_dOmE_A', 'UpperBEAMS']);
    rotunda.getRoot().listNodes()[0]!.setName('Dome node with a wall mesh');
    rotunda.getRoot().listNodes()[3]!.setTranslation([0, 4, 0]);
    await inputs(rotunda);

    const result = await writeCollision(paths.out);
    const { primitive } = await output();
    expect(result.triangles).toBe(5);
    expect(signatures(primitive)).toEqual(expectedTriangles([
      TRIANGLE,
      [10, 0, 0, 11, 0, 0, 10, 1, 0],
      [20, 0, 0, 21, 0, 0, 20, 1, 0],
      [30, 4, 0, 31, 4, 0, 30, 5, 0],
      TRIANGLE,
    ]));
  });

  it('bakes inherited translation, rotation and scale for shared meshes into world positions', async () => {
    const rotunda = new Document();
    const rootScene = rotunda.createScene();
    const mesh = triangle(rotunda, 'Column');
    const parent = rotunda.createNode().setTranslation([10, 0, 5]).setScale([2, 3, 1]);
    parent.addChild(rotunda.createNode().setMesh(mesh).setTranslation([1, 0, 0]));
    rootScene.addChild(parent);
    rootScene.addChild(rotunda.createNode().setMesh(mesh).setTranslation([-5, 0, 0])
      .setRotation([0, 0, Math.SQRT1_2, Math.SQRT1_2]));
    await inputs(rotunda);

    await writeCollision(paths.out);
    const { document, primitive } = await output();
    expect(signatures(primitive)).toEqual(expectedTriangles([
      [12, 0, 5, 14, 0, 5, 12, 3, 5],
      [-5, 0, 0, -5, 1, 0, -6, 0, 0],
      TRIANGLE,
    ]));
    for (const node of document.getRoot().listNodes()) {
      expect(node.getTranslation()).toEqual([0, 0, 0]);
      expect(node.getRotation()).toEqual([0, 0, 0, 1]);
      expect(node.getScale()).toEqual([1, 1, 1]);
    }
  });

  it('unrolls every GPU-instanced column into explicit world geometry', async () => {
    const rotunda = scene(['Column']);
    const buffer = rotunda.getRoot().listBuffers()[0]!;
    const translations = rotunda.createAccessor().setType('VEC3').setBuffer(buffer)
      .setArray(new Float32Array([2, 0, 0, 6, 0, 0]));
    const extension = rotunda.createExtension(EXTMeshGPUInstancing).setRequired(true);
    rotunda.getRoot().listNodes()[0]!.setTranslation([0, 0, 3]).setExtension(
      'EXT_mesh_gpu_instancing', extension.createInstancedMesh().setAttribute('TRANSLATION', translations),
    );
    await inputs(rotunda);

    await writeCollision(paths.out);
    const { document, primitive } = await output();
    expect(signatures(primitive)).toEqual(expectedTriangles([
      [2, 0, 3, 3, 0, 3, 2, 1, 3],
      [6, 0, 3, 7, 0, 3, 6, 1, 3],
      TRIANGLE,
    ]));
    expect(document.getRoot().listExtensionsUsed()).toEqual([]);
  });

  it('writes one plain indexed position-only mesh directly under the scene for capsule collision', async () => {
    const rotunda = scene(['Wall', 'Floor']);
    const root = rotunda.getRoot();
    const texture = rotunda.createTexture().setMimeType('image/png').setImage(new Uint8Array(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=',
      'base64',
    )));
    const material = rotunda.createMaterial().setBaseColorTexture(texture);
    for (const mesh of root.listMeshes()) {
      mesh.listPrimitives()[0]!.setMaterial(material).setAttribute('NORMAL', rotunda.createAccessor()
        .setType('VEC3').setBuffer(root.listBuffers()[0]!).setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])))
        .setAttribute('TEXCOORD_0', rotunda.createAccessor().setType('VEC2').setBuffer(root.listBuffers()[0]!)
          .setArray(new Float32Array([0, 0, 1, 0, 0, 1])));
    }
    await inputs(rotunda);

    const result = await writeCollision(paths.out);
    const { document, primitive } = await output();
    const outputRoot = document.getRoot();
    expect(outputRoot.listScenes()).toHaveLength(1);
    expect(outputRoot.listScenes()[0]!.listChildren()).toHaveLength(1);
    expect(outputRoot.listScenes()[0]!.listChildren()[0]!.getMesh()).toBe(outputRoot.listMeshes()[0]);
    expect(outputRoot.listMeshes()).toHaveLength(1);
    expect(outputRoot.listMeshes()[0]!.getName()).toBe('collision');
    expect(outputRoot.listMeshes()[0]!.listPrimitives()).toHaveLength(1);
    expect(outputRoot.listBuffers()).toHaveLength(1);
    expect(outputRoot.listMaterials()).toEqual([]);
    expect(outputRoot.listTextures()).toEqual([]);
    expect(outputRoot.listExtensionsUsed()).toEqual([]);
    expect(primitive.listSemantics()).toEqual(['POSITION']);
    expect(primitive.getMaterial()).toBeNull();
    expect(primitive.getMode()).toBe(GltfPrimitive.Mode.TRIANGLES);
    expect(primitive.getAttribute('POSITION')!.getType()).toBe(Accessor.Type.VEC3);
    expect(primitive.getAttribute('POSITION')!.getComponentType()).toBe(Accessor.ComponentType.FLOAT);
    expect(primitive.getIndices()!.getCount()).toBe(9);
    expect(result).toEqual({ triangles: 3, bytes: (await readFile(resolve(paths.out, 'collision.glb'))).length });

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(
      Float32Array.from(primitive.getAttribute('POSITION')!.getArray()!), 3,
    ));
    geometry.setIndex(new BufferAttribute(Uint32Array.from(primitive.getIndices()!.getArray()!), 1));
    const foot = new Vector3(0.2, 0, 0.1);
    const resolved = resolveCapsule(new MeshBVH(geometry), foot, { radius: 0.3, height: 1.65 });
    expect(resolved.z).toBeCloseTo(0.3, 5);
    expect(foot.toArray()).toEqual([0.2, 0, 0.1]);
    geometry.dispose();
  });

  it('writes identical full and half GLBs only inside the requested output and preserves inputs', async () => {
    await inputs(scene(['Wall']));
    await writeFile(resolve(paths.content, 'sentinel.txt'), 'default content stays untouched');
    const before = await snapshot(sandbox);

    await writeCollision(paths.out);
    const fullPath = resolve(paths.out, 'collision.glb');
    const halfPath = resolve(paths.out, 'half', 'collision.glb');
    const full = await readFile(fullPath);
    expect(await readFile(halfPath)).toEqual(full);
    expect(vi.mocked(fs.writeFileSync).mock.calls.map(([path]) => path)).toEqual([fullPath, halfPath]);
    expect(vi.mocked(fs.mkdirSync).mock.calls.map(([path]) => path))
      .toEqual([paths.out, resolve(paths.out, 'half')]);
    expect(await snapshot(sandbox)).toEqual({
      ...before,
      'custom-output/collision.glb': full.toString('hex'),
      'custom-output/half/collision.glb': full.toString('hex'),
    });
  });

  it('rejects empty retained geometry without creating either output', async () => {
    await inputs(scene(['Dome', 'Beams']), scene(['DomePlinth']));
    const before = await snapshot(sandbox);

    await expect(writeCollision(paths.out)).rejects.toThrow('collision: failed to produce merged mesh');
    expect(await snapshot(sandbox)).toEqual(before);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });
});
