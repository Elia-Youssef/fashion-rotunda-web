// Stage one of the glTF pipeline: turns the raw Unreal export into the content layout the page
// loads, with no optimization at all. One GLB per look (garment meshes plus the mannequin, the
// mannequin carrying KHR_materials_variants base | light | dark), the rotunda and plinth copied as
// they are, the thumbnails, and catalog.json. Stage two (optimize.mjs) reads this layout and
// rewrites it into public/content/ with compressed textures and geometry.
//
// The default output is assets-src/work/assembled, not public/content: what the page loads is the
// optimized set, and an unoptimized GLB in public/content would ship a 54 MB rotunda unnoticed.
//
//   node pipeline/gltf/assemble.mjs            writes assets-src/work/assembled/
//   node pipeline/gltf/assemble.mjs --out DIR  writes DIR
//
// optimize.mjs imports assemble() rather than spawning this file, so one command runs both stages.

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsVariants } from '@gltf-transform/extensions';
import { mergeDocuments, prune, unpartition } from '@gltf-transform/functions';

import { sourceDir, workDir } from '../config.mjs';

/** Where stage one writes when the caller says nothing. Stage two reads from here. */
export const assembledDir = resolve(workDir, 'assembled');

/** Unreal's text export sometimes keeps the NSLOCTEXT wrapper; the page wants the sentence only. */
export function plainText(value) {
  if (typeof value !== 'string') return '';
  const match = value.match(/^NSLOCTEXT\("[^"]*",\s*"[^"]*",\s*"([\s\S]*)"\)$/);
  const text = match ? match[1] : value;
  return text
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Moves every scene node of `part` into `target`'s single scene under one named node, and returns
 * the materials that came with it. mergeDocuments keeps the part's scene; that scene is dropped
 * after its children are re-parented.
 */
function graft(target, part, nodeName) {
  const before = new Set(target.getRoot().listMaterials());
  mergeDocuments(target, part);
  const root = target.getRoot();
  const scenes = root.listScenes();
  const targetScene = scenes[0];
  const group = target.createNode(nodeName);
  targetScene.addChild(group);
  for (const scene of scenes.slice(1)) {
    for (const child of scene.listChildren()) {
      group.addChild(child);
    }
    scene.dispose();
  }
  const materials = root.listMaterials().filter((material) => !before.has(material));
  return { group, materials };
}

function nameNodes(group, prefix) {
  let index = 0;
  group.traverse((node) => {
    if (node === group) return;
    if (node.getMesh() && node.getName() === '') {
      node.setName(index === 0 ? prefix : `${prefix}-${index}`);
      index += 1;
    }
  });
}

async function assembleLook(io, look, out) {
  const document = new Document();
  document.createScene('look');
  const garmentNames = [];
  for (const [index, garment] of look.garments.entries()) {
    const part = await io.read(garment.file);
    const label = index === 0 ? 'garment' : `garment-${index}`;
    const { group } = graft(document, part, label);
    nameNodes(group, `${label}-mesh`);
    garmentNames.push(label);
  }
  const mannequinPart = await io.read(look.mannequin.file);
  const mannequin = graft(document, mannequinPart, 'mannequin');
  const mannequinGroup = mannequin.group;
  const mannequinMaterials = mannequin.materials;
  nameNodes(mannequinGroup, 'mannequin-mesh');

  // Variants: the base variant is the mannequin's own material; light and dark come from the swatch
  // exports, whose preview sphere is dropped by prune once its material has been re-pointed.
  const variantsExtension = document.createExtension(KHRMaterialsVariants);
  const variantMaterials = new Map();
  variantMaterials.set('base', mannequinMaterials[0]);
  for (const name of ['light', 'dark']) {
    const swatch = look.swatches[name];
    if (!swatch) continue;
    const part = await io.read(swatch.file);
    const { group, materials } = graft(document, part, `swatch-${name}`);
    variantMaterials.set(name, materials[0]);
    group.dispose();
  }
  const variantNames = ['base', 'light', 'dark'].filter((name) => variantMaterials.has(name));
  const variants = new Map(variantNames.map((name) => [name, variantsExtension.createVariant(name)]));
  mannequinGroup.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    for (const primitive of mesh.listPrimitives()) {
      const mappingList = variantsExtension.createMappingList();
      for (const name of variantNames) {
        const mapping = variantsExtension
          .createMapping()
          .setMaterial(variantMaterials.get(name))
          .addVariant(variants.get(name));
        mappingList.addMapping(mapping);
      }
      primitive.setExtension('KHR_materials_variants', mappingList);
    }
  });
  // Each merged part brought its own buffer; a GLB may hold only one.
  await document.transform(prune(), unpartition());

  const file = `looks/${look.slug}.glb`;
  await io.write(resolve(out, file), document);
  const thumbnail = look.thumbnail ? `thumbs/${look.slug}.png` : null;
  if (thumbnail) copyFileSync(look.thumbnail.file, resolve(out, thumbnail));
  return {
    id: look.slug,
    name: look.name,
    description: plainText(look.description),
    thumbnail,
    file,
    audio: null,
    variants: variantNames,
    defaultVariant: 'base',
    mannequinNode: 'mannequin',
    garmentNodes: garmentNames,
  };
}

/**
 * Runs stage one.
 *
 * @param out where to write. Defaults to assets-src/work/assembled.
 * @param log a one-line progress sink.
 * @returns `{ out, catalog, source }` so stage two can reuse the parsed export description.
 */
export async function assemble({ out = assembledDir, log = console.log } = {}) {
  const src = resolve(sourceDir, 'unreal');
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const source = JSON.parse(readFileSync(resolve(src, 'catalog-source.json'), 'utf8'));

  mkdirSync(resolve(out, 'looks'), { recursive: true });
  mkdirSync(resolve(out, 'thumbs'), { recursive: true });

  copyFileSync(source.rotunda.file, resolve(out, 'rotunda.glb'));
  copyFileSync(source.plinth.file, resolve(out, 'plinth.glb'));
  const looks = [];
  for (const look of source.looks) {
    looks.push(await assembleLook(io, look, out));
    const last = looks.at(-1);
    log(
      `assembled ${look.slug}: ${last.garmentNodes.length} garment group(s), ` +
        `variants ${last.variants.join(', ')}`,
    );
  }

  const catalog = {
    version: 1,
    rotunda: { file: 'rotunda.glb' },
    plinth: { file: 'plinth.glb' },
    looks,
    views: {
      // A first proof pose on the plinth; G1.5's views.json replaces it. Metres, y up.
      proof: { position: [0, 1.7, 4.2], target: [0, 1.0, 0], fov: 40 },
    },
  };
  writeFileSync(resolve(out, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  log(`catalog.json: ${looks.length} looks -> ${out}`);
  log(`rotunda ${basename(source.rotunda.file)} and plinth copied unoptimized`);
  return { out, catalog, source };
}

// Run only when this file is the entry point; optimize.mjs imports assemble() instead.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  await assemble({ out: outIndex >= 0 ? resolve(args[outIndex + 1]) : assembledDir });
}
