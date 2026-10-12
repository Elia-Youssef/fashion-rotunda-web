// Stage two of the glTF pipeline: reads the assembled layout and writes what the page loads.
//
//   npm run pipeline:optimize
//   node pipeline/gltf/optimize.mjs [--skip-assemble] [--only <name>] [--out DIR]
//
// It runs stage one first (assemble.mjs, into assets-src/work/assembled) and then, per file, the
// following order: dedup, instance (rotunda only), weld, the material repairs, the
// default KHR_materials_specular stripping, resize, KTX2 encode, meshopt, prune. The half set branches off
// before resize, strips clearcoat, decimates any garment over the phone budget, and caps its
// textures lower.
//
// Two rules shape the structure:
//
//   - Instancing and material variants do not combine. EXT_mesh_gpu_instancing needs the instanced
//     nodes to share one mesh with one material set, so only the rotunda is instanced and a look
//     never is.
//   - A failed texture must not take the run down with it. Each texture is encoded on its own, and
//     a failure is recorded in manifest.errors and the run continues.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { Logger, NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  cloneDocument,
  dedup,
  instance,
  meshopt,
  prune,
  simplifyPrimitive,
  unpartition,
  weld,
} from '@gltf-transform/functions';
import { Mode, toktx } from '@gltf-transform/cli';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

import { contentDir, pipelineEnv, root, sourceDir } from '../config.mjs';
import { ENVIRONMENT_FILE } from '../environment.mjs';
import { assemble, assembledDir } from './assemble.mjs';
import { writeCollision } from './collision.mjs';
import { budgetRows, formatBudgetTable, formatMb } from './lib/budget.mjs';
import { buildManifest, fileEntry, shippedJson, textureEntry } from './lib/manifest.mjs';
import { ktx2Format } from './lib/naming.mjs';
import { validateOutputContract } from './lib/output-contract.mjs';
import { planFactorResets, planRepairs } from './lib/repairs.mjs';
import { shouldPreserveSpecular } from './lib/specular.mjs';
import { canonicalizeSourceTextures, getOrCreateSourceTexture } from './lib/texture-authority.mjs';

import { needsResize } from './lib/sizing.mjs';
import { planTextures } from './lib/texture-plan.mjs';

/** instance() needs this many nodes on one mesh before it makes a batch. The rotunda's repeated
 *  beams and columns sit at eight each; the walls at two and four stay as they are. */
const INSTANCE_MIN = 5;

/** The half set's triangle budget for one look, mannequin included (the budget table). */
const HALF_LOOK_TRIANGLES = 120000;

/** meshoptimizer's error bound, as a fraction of the mesh extent. The library default of 1e-4 stops
 *  the simplifier before a 6 percent decimation is reached, so the bound is loosened to 0.5 percent
 *  and the achieved triangle count is printed and budgeted rather than assumed. */
const SIMPLIFY_ERROR = 0.005;

/** JPEG thumbnails: 512 px wide for the full set, half that for the phone set. */
const THUMBNAIL_WIDTH = { full: 512, half: 256 };
const THUMBNAIL_QUALITY = 82;

/** The three.js KTX2 transcoder the page loads beside the models. */
const BASIS_SOURCE = resolve(root, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');

/** What optimize.mjs owns inside the output folder. Everything here is deleted and rewritten, and
 *  nothing else is touched, so unrelated sibling folders survive a run. */
const OWNED_OUTPUTS = [
  'rotunda.glb',
  'plinth.glb',
  'looks',
  'thumbs',
  'half',
  'basis',
  'catalog.json',
  'manifest.json',
];

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const out = outIndex >= 0 ? resolve(args[outIndex + 1]) : contentDir;
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
  const skipAssemble = args.includes('--skip-assemble');

  // toktx spawns the KTX-Software "ktx" executable by bare name (@gltf-transform/cli
  // dist/cli.mjs:679, guarded by checkKTXSoftware at :748). It is installed off PATH on purpose,
  // so PATH is set for this process before the first call.
  process.env.PATH = pipelineEnv().PATH;

  await MeshoptEncoder.ready;
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;

  const started = performance.now();
  const catalog = skipAssemble
    ? JSON.parse(readFileSync(resolve(assembledDir, 'catalog.json'), 'utf8'))
    : (await assemble({ out: assembledDir })).catalog;

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

  for (const name of OWNED_OUTPUTS) rmSync(resolve(out, name), { recursive: true, force: true });
  for (const dir of ['looks', 'thumbs', 'half/looks', 'half/thumbs', 'basis']) {
    mkdirSync(resolve(out, dir), { recursive: true });
  }

  const plan = [
    { file: 'rotunda.glb', textures: 'rotunda/textures', instanced: true },
    { file: 'plinth.glb', textures: null, instanced: false },
    ...catalog.looks.map((look) => ({
      file: look.file,
      textures: `looks/${look.id}/textures`,
      instanced: false,
      look,
    })),
  ].filter((item) => only === null || item.file.includes(only));

  const sets = { full: {}, half: {} };
  const errors = [];
  const repairsMade = [];
  const resetsMade = [];

  for (const item of plan) {
    const prepared = await prepare(io, item);
    repairsMade.push(...prepared.repairs);
    resetsMade.push(...prepared.resets);
    // The half set branches before resize: everything above it is shared, everything below differs.
    const half = cloneDocument(prepared.document);
    sets.full[item.file] = await finish(io, prepared.document, item, 'full', out, errors);
    sets.half[item.file] = await finish(io, half, item, 'half', out, errors);
  }

  const environmentPath = resolve(out, ENVIRONMENT_FILE);
  const environmentBytes = statSync(environmentPath).size;
  const environmentEntry = fileEntry({
    bytes: environmentBytes,
    triangles: 0,
    meshes: 0,
    nodes: 0,
    materials: 0,
    drawCalls: 0,
    textures: [],
  });
  // Both asset sets share this one file under /content/env. It is listed in each set because it is
  // part of either tier's first frame, even though it is stored only once on disk.
  sets.full[ENVIRONMENT_FILE] = environmentEntry;
  sets.half[ENVIRONMENT_FILE] = environmentEntry;

  await writeCollision(out);

  await writeThumbnails(catalog, out);
  const shipped = shippedCatalog(catalog);
  writeFileSync(resolve(out, 'catalog.json'), shippedJson(shipped));
  writeFileSync(resolve(out, 'half', 'catalog.json'), shippedJson(shipped));
  copyBasisTranscoder(out);

  const manifest = buildManifest(new Date().toISOString().replace(/\.\d+Z$/, 'Z'), sets, errors);
  writeFileSync(resolve(out, 'manifest.json'), shippedJson(manifest));

  console.log('');
  if (repairsMade.length === 0) console.log('repairs: none');
  for (const repair of repairsMade) {
    console.log(
      `repair ${repair.file} ${repair.material}.${repair.slot}: ` +
        `${repair.from ?? '(empty)'} -> ${repair.to} [${repair.reason}, from the ${repair.origin}]`,
    );
  }
  for (const reset of resetsMade) {
    console.log(
      `repair ${reset.file} ${reset.material}: ${reset.factor} factor ` +
        `${JSON.stringify(reset.from)} -> ${JSON.stringify(reset.to)}`,
    );
  }
  console.log('');
  for (const set of ['full', 'half']) {
    const { rows, info } = budgetRows(
      set,
      manifest.sets[set].files,
      catalog.looks[0].file,
      shipped.environment.file,
    );
    console.log(formatBudgetTable(set, rows, info));
    console.log('');
  }
  if (errors.length > 0) {
    console.log(`texture errors: ${errors.length} recorded in manifest.errors`);
    for (const error of errors) {
      console.log(`  ${error.set} ${error.file} ${error.texture}: ${error.message}`);
    }
  } else {
    console.log('texture errors: none');
  }
  console.log(`optimize complete in ${((performance.now() - started) / 1000).toFixed(1)} s -> ${out}`);
}

/**
 * Everything both sets share: dedup, instancing, weld, the repairs, default specular stripping, and a
 * texture-only prune so nothing orphaned by a repair is paid for twice in the encoder.
 */
async function prepare(io, item) {
  const document = await io.read(resolve(assembledDir, item.file));
  // The default logger prints an info line per transform, and there are hundreds of transforms in
  // a run. Warnings and errors still come through.
  document.setLogger(new Logger(Logger.Verbosity.WARN));
  await document.transform(dedup());
  if (item.instanced) await document.transform(instance({ min: INSTANCE_MIN }));
  await document.transform(weld());
  const { repairs, resets, canonicalized } = applyRepairs(document, item);
  stripDefaultSpecular(document);
  // Textures orphaned by a repair, and solid-colour textures, go now: both would otherwise cost an
  // encoder pass, and the solid-colour check has to read pixels, which it can only do while the
  // images are still PNG.
  await document.transform(prune({ propertyTypes: [PropertyType.TEXTURE] }));
  console.log(
    `prepared ${item.file}: ${countTriangles(document)} triangles, ${drawCalls(document)} draw calls, ` +
      `${document.getRoot().listTextures().length} textures, ${repairs.length} repair(s), ` +
      `${canonicalized.length} canonical source texture(s)`,
  );
  return { document, repairs, resets };
}

/**
 * Retains non-default authored specular data while dropping no-op extension properties.
 *
 * KHR_materials_specular defaults to factor 1 and white colour. Calling disposeExtension() here
 * would erase non-default source values from every material, so each material is handled first.
 */
function stripDefaultSpecular(document) {
  for (const material of document.getRoot().listMaterials()) {
    const specular = material.getExtension('KHR_materials_specular');
    if (!specular) continue;
    if (
      !shouldPreserveSpecular({
        factor: specular.getSpecularFactor(),
        color: specular.getSpecularColorFactor(),
        hasSpecularTexture: specular.getSpecularTexture() !== null,
        hasSpecularColorTexture: specular.getSpecularColorTexture() !== null,
      })
    ) {
      material.setExtension('KHR_materials_specular', null);
    }
  }
}

/** Everything that differs per set: clearcoat, decimation, resize, encode, meshopt, prune, write. */
async function finish(io, document, item, set, out, errors) {
  if (set === 'half') {
    // Clearcoat is a second specular lobe on the marble. It is the first thing to go on a phone,
    // and dropping it also drops its own normal map from the payload.
    document.disposeExtension('KHR_materials_clearcoat');
    decimateGarments(document, item, set);
  }
  const texturePlan = planTextures(document, set, item);
  await resizeTextures(texturePlan, set, item);
  const textures = await encodeTextures(document, texturePlan, set, item, errors);
  await document.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  // keepSolidTextures: every image is KTX2 by now and the solid-colour check decodes pixels. The
  // same check already ran on the PNGs in prepare().
  await document.transform(prune({ keepSolidTextures: true }), unpartition());

  const path = set === 'full' ? resolve(out, item.file) : resolve(out, 'half', item.file);
  mkdirSync(dirname(path), { recursive: true });
  await io.write(path, document);
  // Re-read serialized bytes instead of trusting the in-memory graph. A missing KTX image or a
  // pruned slot must stop this run before its manifest can claim the asset passed.
  validateOutputContract(await io.read(path), { set, file: item.file });
  const bytes = statSync(path).size;
  const entry = fileEntry({
    bytes,
    triangles: countTriangles(document),
    meshes: document.getRoot().listMeshes().length,
    nodes: document.getRoot().listNodes().length,
    materials: document.getRoot().listMaterials().length,
    drawCalls: drawCalls(document),
    textures,
  });
  console.log(
    `wrote ${set}/${item.file}: ${formatMb(bytes)}, ${entry.triangles} triangles, ` +
      `${entry.drawCalls} draw calls, ${formatMb(entry.gpuBytes)} on the GPU`,
  );
  return entry;
}

/**
 * Applies the name rule of lib/repairs.mjs. The PNGs exported beside each look are authoritative:
 * the glTF exporter can embed a black or placeholder image under the correct Unreal texture name.
 * Canonicalizing those matching names before slot repair also fixes maps in slots that need no repair.
 */
function applyRepairs(document, item) {
  if (!item.textures) return { repairs: [], resets: [], canonicalized: [] };
  const dir = resolve(sourceDir, 'unreal', item.textures);
  const available = new Set(
    readdirSync(dir)
      .filter((name) => name.toLowerCase().endsWith('.png'))
      .map((name) => name.slice(0, -4)),
  );
  const loadSource = (name) => new Uint8Array(readFileSync(resolve(dir, `${name}.png`)));
  const { byName, canonicalized } = canonicalizeSourceTextures(document, available, loadSource);
  const made = [];
  const resetsMade = [];
  for (const material of document.getRoot().listMaterials()) {
    const slots = readSlots(material);
    const repairs = planRepairs(slots, available);
    if (repairs.length === 0) continue;
    for (const repair of repairs) {
      const { texture, created } = getOrCreateSourceTexture(document, byName, repair.to, loadSource);
      SLOT_SETTERS[repair.slot](material, texture);
      made.push({ ...repair, file: item.file, material: slots.name, origin: created ? 'source PNG' : 'canonical source PNG' });
    }
    // A slot the exporter left empty also carries a factor that would multiply the repaired texture
    // away: baseColorFactor [0,0,0,0] renders the garment black, metallic and roughness at 0 render
    // it as a mirror. The factors go back to the glTF defaults with the texture.
    for (const reset of planFactorResets(repairs, readFactors(material))) {
      FACTOR_SETTERS[reset.factor](material, reset.to);
      resetsMade.push({ ...reset, file: item.file, material: slots.name });
    }
  }
  return { repairs: made, resets: resetsMade, canonicalized };
}

const SLOT_SETTERS = {
  baseColor: (material, texture) => material.setBaseColorTexture(texture),
  normal: (material, texture) => material.setNormalTexture(texture),
  metallicRoughness: (material, texture) => material.setMetallicRoughnessTexture(texture),
  occlusion: (material, texture) => material.setOcclusionTexture(texture),
};

const FACTOR_SETTERS = {
  baseColor: (material, value) => material.setBaseColorFactor(value),
  metallic: (material, value) => material.setMetallicFactor(value),
  roughness: (material, value) => material.setRoughnessFactor(value),
};

function readSlots(material) {
  return {
    name: material.getName(),
    baseColor: material.getBaseColorTexture()?.getName() ?? null,
    normal: material.getNormalTexture()?.getName() ?? null,
    metallicRoughness: material.getMetallicRoughnessTexture()?.getName() ?? null,
    occlusion: material.getOcclusionTexture()?.getName() ?? null,
  };
}

function readFactors(material) {
  return {
    baseColor: material.getBaseColorFactor(),
    metallic: material.getMetallicFactor(),
    roughness: material.getRoughnessFactor(),
  };
}

/** Decimates a look's garment primitives, and only those, when the look is over the phone budget. */
function decimateGarments(document, item, set) {
  if (!item.look) return;
  const garments = garmentPrimitives(document);
  if (garments.length === 0) return;
  const total = countTriangles(document);
  const garmentTriangles = garments.reduce((sum, primitive) => sum + primitiveTriangles(primitive), 0);
  const allowance = HALF_LOOK_TRIANGLES - (total - garmentTriangles);
  if (garmentTriangles <= allowance) return;
  const ratio = allowance / garmentTriangles;
  for (const primitive of garments) {
    simplifyPrimitive(primitive, { simplifier: MeshoptSimplifier, ratio, error: SIMPLIFY_ERROR });
  }
  console.log(
    `simplified ${set}/${item.file}: garments ${garmentTriangles} -> ` +
      `${garments.reduce((sum, primitive) => sum + primitiveTriangles(primitive), 0)} triangles ` +
      `(ratio ${ratio.toFixed(4)}, error ${SIMPLIFY_ERROR})`,
  );
}

/** Resizes each texture to its cap for this set. sharp is the only image resizer in the pipeline. */
async function resizeTextures(texturePlan, set, item) {
  for (const { texture, size, target } of texturePlan) {
    if (!size) continue;
    if (!needsResize(size, target)) continue;
    const image = texture.getImage();
    const resized = await sharp(Buffer.from(image.buffer, image.byteOffset, image.byteLength))
      .resize(target[0], target[1], { fit: 'fill', kernel: 'lanczos3' })
      .png()
      .toBuffer();
    texture.setImage(new Uint8Array(resized)).setMimeType('image/png');
    console.log(
      `  resize ${set}/${item.file} ${texture.getName()}: ${size.join('x')} -> ${target.join('x')}`,
    );
  }
}

/**
 * Encodes every texture to KTX2, one call per texture.
 *
 * One call per texture buys two things the grouped form cannot: a time and a size per texture, and
 * isolation, so a texture the encoder refuses is recorded and skipped instead of ending the run.
 * jobs is 1 on purpose: @gltf-transform/cli only passes `--threads` when jobs > 1, and the cap it
 * computes (3 * cores / textureCount) would hand a single texture three threads out of twenty-four.
 */
async function encodeTextures(document, texturePlan, set, item, errors) {
  // Apply all planned names together, after resize and before the first exact-name encoder call.
  for (const { texture, name } of texturePlan) {
    if (name !== texture.getName()) texture.setName(name);
  }
  const entries = [];
  for (const { texture, name, pattern, encoding, colorSpace, floor } of texturePlan) {
    const size = texture.getSize() ?? [0, 0];
    const before = texture.getImage()?.byteLength ?? 0;
    const started = performance.now();
    let message = null;
    try {
      await document.transform(
        toktx({
          mode: encoding === 'uastc' ? Mode.UASTC : Mode.ETC1S,
          encoder: sharp,
          pattern,
          jobs: 1,
        }),
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    if (message === null && texture.getMimeType() !== 'image/ktx2') {
      message = 'ktx produced no KTX2 payload; see the encoder output above';
    }
    if (message !== null) {
      errors.push({ set, file: item.file, texture: name, message });
      console.log(`  encode ${set}/${item.file} ${name}: FAILED ${message}`);
      entries.push(
        textureEntry({
          name,
          width: size[0],
          height: size[1],
          format: texture.getMimeType() === 'image/jpeg' ? 'jpeg' : 'png',
          colorSpace,
          bytes: texture.getImage()?.byteLength ?? 0,
          floor,
        }),
      );
      continue;
    }
    const after = texture.getImage().byteLength;
    const seconds = (performance.now() - started) / 1000;
    console.log(
      `  encode ${set}/${item.file} ${name}: ${size.join('x')} ${encoding} ${colorSpace} ` +
        `${formatMb(before)} -> ${formatMb(after)} in ${seconds.toFixed(1)} s`,
    );
    entries.push(
      textureEntry({
        name,
        width: size[0],
        height: size[1],
        format: ktx2Format(encoding),
        colorSpace,
        bytes: after,
        floor,
      }),
    );
  }
  return entries;
}

function garmentPrimitives(document) {
  const primitives = new Set();
  for (const scene of document.getRoot().listScenes()) {
    for (const child of scene.listChildren()) {
      if (!child.getName().startsWith('garment')) continue;
      child.traverse((node) => {
        const mesh = node.getMesh();
        if (!mesh) return;
        for (const primitive of mesh.listPrimitives()) primitives.add(primitive);
      });
    }
  }
  return [...primitives];
}

function primitiveTriangles(primitive) {
  const indices = primitive.getIndices();
  const position = primitive.getAttribute('POSITION');
  const count = indices ? indices.getCount() : position ? position.getCount() : 0;
  switch (primitive.getMode()) {
    case 4:
      return Math.floor(count / 3);
    case 5:
    case 6:
      return Math.max(0, count - 2);
    default:
      return 0;
  }
}

function countTriangles(document) {
  let total = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) total += primitiveTriangles(primitive);
  }
  return total;
}

/** One draw call per node-primitive pair. An instanced batch is one node, so it counts once. */
function drawCalls(document) {
  let calls = 0;
  for (const scene of document.getRoot().listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (mesh) calls += mesh.listPrimitives().length;
    });
  }
  return calls;
}

/** JPEG thumbnails for both sets, from the PNG stage one copied out of Unreal. */
async function writeThumbnails(catalog, out) {
  for (const look of catalog.looks) {
    if (!look.thumbnail) continue;
    const source = resolve(assembledDir, look.thumbnail);
    for (const set of ['full', 'half']) {
      const path = set === 'full'
        ? resolve(out, 'thumbs', `${look.id}.jpg`)
        : resolve(out, 'half', 'thumbs', `${look.id}.jpg`);
      const info = await sharp(source)
        .resize({ width: THUMBNAIL_WIDTH[set] })
        .jpeg({ quality: THUMBNAIL_QUALITY })
        .toFile(path);
      console.log(`thumbnail ${set} ${look.id}.jpg: ${info.width}x${info.height}, ${info.size} bytes`);
    }
  }
}

/** The catalogue as shipped. The only change is the thumbnail extension: stage one copied the PNG
 *  out of Unreal, stage two ships a 512 px JPEG under the same name. */
function shippedCatalog(catalog) {
  return {
    ...catalog,
    environment: { file: ENVIRONMENT_FILE },
    looks: catalog.looks.map((look) => ({
      ...look,
      thumbnail: look.thumbnail ? `thumbs/${look.id}.jpg` : null,
    })),
  };
}

/**
 * The KTX2 transcoder the page's KTX2Loader fetches from content/basis/, copied byte for byte from
 * three's examples. eslint.config.js ignores public/, so the vendored file is never linted.
 */
function copyBasisTranscoder(out) {
    copyFileSync(resolve(BASIS_SOURCE, 'basis_transcoder.js'), resolve(out, 'basis', 'basis_transcoder.js'));
  const wasm = 'basis_transcoder.wasm';
  copyFileSync(resolve(BASIS_SOURCE, wasm), resolve(out, 'basis', wasm));
  console.log('basis: transcoder copied from three/examples/jsm/libs/basis');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
