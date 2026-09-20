// Generates the single collision mesh for first-person walkthrough.
// Reads the rotunda and plinth, merges walls, floor, columns and plinth,
// welds and simplifies with MeshoptSimplifier to under 8,000 triangles within 2 cm error,
// and writes an uncompressed collision.glb into both content sets.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  clearNodeTransform,
  dequantize,
  flatten,
  join,
  mergeDocuments,
  prune,
  simplifyPrimitive,
  uninstance,
  unpartition,
  weld,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';

import { contentDir } from '../config.mjs';

const TARGET_TRIANGLES = 8000;
// 2 cm error bound in metres to keep walls faithful to visual bounds.
const SIMPLIFY_ERROR = 0.02;

/**
 * Builds the collision geometry and writes collision.glb into out and out/half.
 * @param {string} [out] Output directory (defaults to contentDir).
 */
export async function writeCollision(out = contentDir) {
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

  const rotundaPath = existsSync(resolve(out, 'rotunda.glb'))
    ? resolve(out, 'rotunda.glb')
    : resolve(contentDir, 'rotunda.glb');
  const plinthPath = existsSync(resolve(out, 'plinth.glb'))
    ? resolve(out, 'plinth.glb')
    : resolve(contentDir, 'plinth.glb');

  const rotundaDoc = await io.read(rotundaPath);
  const plinthDoc = await io.read(plinthPath);

  // Unroll instanced columns and node transforms into explicit world geometry.
  await rotundaDoc.transform(dequantize(), uninstance(), flatten());
  await plinthDoc.transform(dequantize(), flatten());

  mergeDocuments(rotundaDoc, plinthDoc);

  const root = rotundaDoc.getRoot();
  const scenes = root.listScenes();
  if (scenes.length > 1) {
    const mainScene = scenes[0];
    for (let i = 1; i < scenes.length; i += 1) {
      for (const child of scenes[i].listChildren()) {
        mainScene.addChild(child);
      }
      scenes[i].dispose();
    }
  }

  // Exclude the dome and upper beams above human scale (above 3 m).
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    const name = mesh?.getName() ?? '';
    if (/Dome|Beams/i.test(name)) {
      node.dispose();
    }
  }
  await rotundaDoc.transform(prune());

  // Bake node world transforms into cloned meshes so join merges them all.
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (mesh) {
      node.setMesh(mesh.clone());
      clearNodeTransform(node);
    }
  }

  // Strip all textures, materials and non-position attributes.
  for (const mesh of rotundaDoc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      prim.setMaterial(null);
      for (const semantic of prim.listSemantics()) {
        if (semantic !== 'POSITION') {
          prim.setAttribute(semantic, null);
        }
      }
    }
  }

  for (const mat of rotundaDoc.getRoot().listMaterials()) {
    mat.dispose();
  }
  for (const tex of rotundaDoc.getRoot().listTextures()) {
    tex.dispose();
  }

  // Remove compression extensions to write plain uncompressed glTF.
  for (const ext of rotundaDoc.getRoot().listExtensionsUsed()) {
    rotundaDoc.disposeExtension(ext.extensionName);
  }

  // Join every primitive into one mesh and one buffer.
  await rotundaDoc.transform(prune(), join(), weld(), unpartition());

  const mesh = rotundaDoc.getRoot().listMeshes()[0];
  if (!mesh) {
    throw new Error('collision: failed to produce merged mesh');
  }
  mesh.setName('collision');

  const prim = mesh.listPrimitives()[0];
  const indices = prim.getIndices();
  const initialTriangles = indices ? indices.getCount() / 3 : 0;

  if (initialTriangles > TARGET_TRIANGLES) {
    const ratio = TARGET_TRIANGLES / initialTriangles;
    simplifyPrimitive(prim, {
      simplifier: MeshoptSimplifier,
      ratio,
      error: SIMPLIFY_ERROR,
    });
  }

  const finalIndices = prim.getIndices();
  const finalTriangles = finalIndices ? finalIndices.getCount() / 3 : 0;
  const glbBytes = await io.writeBinary(rotundaDoc);

  const targets = [resolve(out, 'collision.glb'), resolve(out, 'half', 'collision.glb')];

  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, glbBytes);
  }

  console.log(
    `collision: ${finalTriangles} triangles, ${(glbBytes.byteLength / 1024).toFixed(1)} KB ` +
      `(${glbBytes.byteLength} bytes) written to ${targets.join(', ')}`,
  );

  return {
    triangles: finalTriangles,
    bytes: glbBytes.byteLength,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const targetOut = outIndex >= 0 ? resolve(args[outIndex + 1]) : contentDir;
  await writeCollision(targetOut);
}
