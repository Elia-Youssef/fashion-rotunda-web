// Prints what a glTF file contains: nodes, meshes, triangles, materials, textures and extensions. Used to
// audit the Unreal export before the optimize pass and the optimize output before it ships.
//
//   node pipeline/gltf/inspect.mjs <file.glb> [more files...] [--json]
//
// The optimize pass writes meshopt-compressed geometry, so the reader registers the meshopt decoder:
// without it every optimized file reads as an error. The summary line ends with the five checks the
// output has to pass, so the answer is readable without scrolling: KTX2 on every texture, meshopt
// present, instancing on the rotunda, authored KHR_materials_specular values retained, variants on
// every look.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const files = args.filter((arg) => !arg.startsWith('--'));
if (files.length === 0) {
  console.error('usage: node pipeline/gltf/inspect.mjs <file.glb> [more files...] [--json]');
  process.exit(2);
}

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder });

function triangleCount(primitive) {
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

function imageSize(texture) {
  // PNG: width and height at bytes 16 and 20. JPEG: scan the SOF marker. KTX2: pixelWidth at 20, height at 24.
  const data = texture.getImage();
  if (!data) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const mime = texture.getMimeType();
  if (mime === 'image/png' && data.byteLength > 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mime === 'image/ktx2' && data.byteLength > 28) {
    return { width: view.getUint32(20, true), height: view.getUint32(24, true) };
  }
  if (mime === 'image/jpeg') {
    let offset = 2;
    while (offset + 9 < data.byteLength) {
      if (data[offset] !== 0xff) return null;
      const marker = data[offset + 1];
      const length = view.getUint16(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

async function inspect(file) {
  const bytes = readFileSync(file).byteLength;
  const document = await io.read(file);
  const root = document.getRoot();
  let triangles = 0;
  let primitives = 0;
  const meshes = root.listMeshes().map((mesh) => {
    let meshTriangles = 0;
    for (const primitive of mesh.listPrimitives()) {
      meshTriangles += triangleCount(primitive);
      primitives += 1;
    }
    triangles += meshTriangles;
    return { name: mesh.getName(), primitives: mesh.listPrimitives().length, triangles: meshTriangles };
  });
  const nodes = root.listNodes().map((node) => ({
    name: node.getName(),
    mesh: node.getMesh()?.getName() ?? null,
    light: node.getExtension('KHR_lights_punctual') ? node.getExtension('KHR_lights_punctual').getType() : null,
    camera: node.getCamera() ? true : false,
  }));
  const materials = root.listMaterials().map((material) => {
    const specular = material.getExtension('KHR_materials_specular');
    return {
      name: material.getName(),
      baseColor: material.getBaseColorTexture()?.getName() ?? null,
      metallicRoughness: material.getMetallicRoughnessTexture()?.getName() ?? null,
      normal: material.getNormalTexture()?.getName() ?? null,
      occlusion: material.getOcclusionTexture()?.getName() ?? null,
      emissive: material.getEmissiveTexture()?.getName() ?? null,
      alphaMode: material.getAlphaMode(),
      doubleSided: material.getDoubleSided(),
      specular: specular
        ? {
            factor: specular.getSpecularFactor(),
            color: specular.getSpecularColorFactor(),
            texture: specular.getSpecularTexture()?.getName() ?? null,
            colorTexture: specular.getSpecularColorTexture()?.getName() ?? null,
          }
        : null,
      extensions: material.listExtensions().map((extension) => extension.extensionName),
    };
  });
  const textures = root.listTextures().map((texture) => ({
    name: texture.getName(),
    mime: texture.getMimeType(),
    bytes: texture.getImage()?.byteLength ?? 0,
    size: imageSize(texture),
  }));
  const lights = nodes.filter((node) => node.light !== null).length;
  const extensionsUsed = root.listExtensionsUsed().map((extension) => extension.extensionName);
  let drawCalls = 0;
  const instanced = [];
  for (const scene of root.listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;
      drawCalls += mesh.listPrimitives().length;
      const batch = node.getExtension('EXT_mesh_gpu_instancing');
      if (batch) {
        const attribute = batch.getAttribute('TRANSLATION') ?? batch.getAttribute('ROTATION');
        instanced.push({ mesh: mesh.getName(), count: attribute ? attribute.getCount() : 0 });
      }
    });
  }
  const variants = root
    .listExtensionsUsed()
    .filter((extension) => extension.extensionName === 'KHR_materials_variants')
    .flatMap((extension) => extension.listProperties())
    .filter((property) => property.propertyType === 'Variant')
    .map((property) => property.getName());
  return {
    file: basename(file),
    bytes,
    scenes: root.listScenes().length,
    nodes: nodes.length,
    meshes: meshes.length,
    primitives,
    triangles,
    drawCalls,
    materials: materials.length,
    textures: textures.length,
    textureBytes: textures.reduce((sum, texture) => sum + texture.bytes, 0),
    lights,
    cameras: root.listCameras().length,
    extensionsUsed,
    checks: {
      ktx2: `${textures.filter((texture) => texture.mime === 'image/ktx2').length}/${textures.length}`,
      meshopt: extensionsUsed.includes('EXT_meshopt_compression'),
      instancing: instanced,
      specular: materials
        .filter((material) => material.specular !== null)
        .map((material) => ({ name: material.name, ...material.specular })),
      variants,
    },
    detail: { nodes, meshes, materials, textures, instanced },
  };
}

const results = [];
for (const file of files) {
  try {
    results.push(await inspect(file));
  } catch (error) {
    results.push({ file: basename(file), error: error instanceof Error ? error.message : String(error) });
  }
}

if (asJson) {
  console.log(JSON.stringify(results, null, 1));
} else {
  for (const result of results) {
    if (result.error) {
      console.log(`${result.file}: ERROR ${result.error}`);
      continue;
    }
    const mb = (result.bytes / 1_000_000).toFixed(2);
    const textureMb = (result.textureBytes / 1_000_000).toFixed(2);
    console.log(
      `${result.file}: ${mb} MB, ${result.nodes} nodes, ${result.meshes} meshes, ` +
        `${result.primitives} primitives, ` +
        `${result.triangles} triangles, ${result.drawCalls} draw calls, ${result.materials} materials, ` +
        `${result.textures} textures (${textureMb} MB), ` +
        `${result.lights} lights, ${result.cameras} cameras, ` +
        `extensions [${result.extensionsUsed.join(', ')}]`,
    );
    const instancing = result.checks.instancing.length
      ? result.checks.instancing.map((batch) => `${batch.mesh} x${batch.count}`).join(', ')
      : 'none';
    const specular = result.checks.specular.length
      ? result.checks.specular.map((material) => `${material.name || '(unnamed)'}=${material.factor}`).join(', ')
      : 'absent';
    console.log(
      `    checks: ktx2 ${result.checks.ktx2}, meshopt ${result.checks.meshopt ? 'yes' : 'no'}, ` +
        `instancing ${instancing}, KHR_materials_specular ${specular}, ` +
        `variants [${result.checks.variants.join(', ')}]`,
    );
    for (const texture of result.detail.textures) {
      const size = texture.size ? `${texture.size.width}x${texture.size.height}` : '?';
      console.log(`    texture ${texture.name || '(unnamed)'} ${texture.mime} ${size} ${(texture.bytes / 1000).toFixed(0)} KB`);
    }
    for (const material of result.detail.materials) {
      console.log(
        `    material ${material.name || '(unnamed)'} base=${material.baseColor ?? '-'} mr=${material.metallicRoughness ?? '-'} ` +
          `n=${material.normal ?? '-'} ao=${material.occlusion ?? '-'} ${material.alphaMode}${material.doubleSided ? ' 2s' : ''}` +
          `${material.specular ? ` specular=${material.specular.factor}` : ''}` +
          `${material.extensions.length ? ' ' + material.extensions.join(',') : ''}`,
      );
    }
  }
}
