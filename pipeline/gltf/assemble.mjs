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
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, KHRMaterialsVariants } from '@gltf-transform/extensions';
import { mergeDocuments, prune, unpartition } from '@gltf-transform/functions';

import { sourceDir, workDir } from '../config.mjs';
import { applyLookText, validateLookText } from './lib/catalog-text.mjs';
import { GARMENT_PLACEMENTS } from './lib/garment-placement.mjs';

/** Where stage one writes when the caller says nothing. Stage two reads from here. */
export const assembledDir = resolve(workDir, 'assembled');

const UNREAL_EXPORT_MARKER = '/assets-src/source/unreal/';

/** Tests lexical containment using the path rules that produced the relative path. */
export function isWithinExportRoot(exportRoot, candidate, paths = { relative, isAbsolute }) {
  const fromRoot = paths.relative(exportRoot, candidate);
  return fromRoot.split(/[\\/]/)[0] !== '..' && !paths.isAbsolute(fromRoot);
}

/**
 * Resolves a path recorded by Unreal beneath the current export root. Historical catalogues contain
 * absolute paths to the checkout that produced them; the asset itself is still portable because the
 * suffix below assets-src/source/unreal is stable. Paths outside that root fail closed.
 */
export function resolveExportFile(exportRoot, recordedPath) {
  const value = String(recordedPath ?? '');
  const normalized = value.replace(/\\/g, '/');
  const marker = normalized.toLowerCase().lastIndexOf(UNREAL_EXPORT_MARKER);
  const candidate = marker >= 0
    ? resolve(exportRoot, normalized.slice(marker + UNREAL_EXPORT_MARKER.length))
    : resolve(exportRoot, value);
  if (value === '' || !isWithinExportRoot(resolve(exportRoot), candidate)) {
    throw new Error(`Export file must stay below ${exportRoot}: ${JSON.stringify(recordedPath)}`);
  }
  return candidate;
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

async function assembleLook(io, look, out, exportRoot) {
  const document = new Document();
  document.createScene('look');
  const garmentNames = [];
  for (const [index, garment] of look.garments.entries()) {
    const sourceFile = resolveExportFile(exportRoot, garment.file);
    const part = await io.read(sourceFile);
    const label = index === 0 ? 'garment' : `garment-${index}`;
    const { group } = graft(document, part, label);
    const placement = GARMENT_PLACEMENTS[look.slug]?.[basename(sourceFile)];
    if (placement) {
      group.setScale(placement.scale).setTranslation(placement.translation);
    }
    nameNodes(group, `${label}-mesh`);
    garmentNames.push(label);
  }
  const mannequinPart = await io.read(resolveExportFile(exportRoot, look.mannequin.file));
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
    const part = await io.read(resolveExportFile(exportRoot, swatch.file));
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
  if (thumbnail) copyFileSync(resolveExportFile(exportRoot, look.thumbnail.file), resolve(out, thumbnail));
  return lookEntry(look, garmentNames, variantNames);
}

function lookEntry(look, garmentNames, variantNames) {
  return {
    id: look.slug,
    name: look.name,
    thumbnail: look.thumbnail ? `thumbs/${look.slug}.png` : null,
    file: `looks/${look.slug}.glb`,
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
export async function assemble({ out = assembledDir, log = console.log, only = null,
  exportRoot = resolve(sourceDir, 'unreal') } = {}) {
  const src = resolve(exportRoot);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const source = JSON.parse(readFileSync(resolve(src, 'catalog-source.json'), 'utf8'));
  validateLookText(source.looks.map((look) => ({ id: look.slug })));
  if (only !== null && !source.looks.some((look) => look.slug === only)) {
    throw new Error(`Unknown look selection ${only}`);
  }

  mkdirSync(resolve(out, 'looks'), { recursive: true });
  mkdirSync(resolve(out, 'thumbs'), { recursive: true });

  if (only === null) {
    copyFileSync(resolveExportFile(src, source.rotunda.file), resolve(out, 'rotunda.glb'));
    copyFileSync(resolveExportFile(src, source.plinth.file), resolve(out, 'plinth.glb'));
  }
  const looks = [];
  for (const look of source.looks) {
    if (only !== null && look.slug !== only) {
      looks.push(lookEntry(look, look.garments.map((_, i) => i === 0 ? 'garment' : `garment-${i}`),
        ['base', 'light', 'dark'].filter((name) => name === 'base' || look.swatches[name])));
      continue;
    }
    looks.push(await assembleLook(io, look, out, src));
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
    looks: applyLookText(looks),
    views: {
      // The showroom camera presets. Metres, Y up. All kept strictly inside the orbit limits.
      proof: { position: [0, 1.7, 4.2], target: [0, 1.0, 0], fov: 40 },
      entrance: { position: [0, 2.2, 6.2], target: [0, 1.0, 0], fov: 52 },
      detail: { position: [0, 1.4, 1.396], target: [0, 1.3, 0], fov: 35 },
      inlay: { position: [0, 3.8, 1.8], target: [0, 0.1, 0], fov: 45 },
      dome: { position: [0, 1.1, 3.5], target: [0, 0.9, 0], fov: 55 },
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
