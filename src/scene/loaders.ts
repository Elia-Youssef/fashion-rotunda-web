// Goal G1.7: the one GLTFLoader the page uses, wired for the three things the optimize pass adds
// to every file it writes.
//
// KTX2 textures (KHR_texture_basisu): KTX2Loader transcodes them to whatever compressed format the
// device has. It has to be told which formats those are before the first texture arrives; with a
// WebGPURenderer detectSupport reads renderer.hasFeature (KTX2Loader.js lines 230-242), which
// throws unless the renderer is initialised (Renderer.js lines 3033-3041). createRenderer awaits
// renderer.init(), so by the time this factory runs the answer is available. The async twin
// detectSupportAsync is deprecated since r181 and only forwards to detectSupport
// (KTX2Loader.js lines 213-219), so it is not used here.
//
// meshopt geometry (EXT_meshopt_compression): the decoder compiles a WebAssembly module, exposed
// as the promise MeshoptDecoder.ready (meshopt_decoder.module.js line 165). It is awaited here so
// the loader is never handed a decoder that cannot decode yet, which is why this factory is async.
//
// GPU instancing (EXT_mesh_gpu_instancing): nothing to wire. GLTFLoader implements it itself in
// the GLTFMeshGpuInstancing plugin (class at GLTFLoader.js line 1683, registered by the loader's
// own constructor at lines 248-252) and lists it among the extensions it supports (line 103). It
// builds an InstancedMesh, which the disposal path in showroom.ts treats like any other Mesh.

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { WebGPURenderer } from 'three/webgpu';

import { contentUrl } from '../catalog/catalog';

/**
 * Builds the loader. `contentBase` is the folder the content set lives in ('/content' or
 * '/content/half'); the transcoder sits in its `basis/` subfolder, copied there by the optimize
 * pass from node_modules/three/examples/jsm/libs/basis/.
 */
export async function createGltfLoader(
  renderer: WebGPURenderer,
  contentBase: string,
): Promise<GLTFLoader> {
  const ktx2Loader = new KTX2Loader()
    .setTranscoderPath(contentUrl(contentBase, 'basis/'))
    .detectSupport(renderer);

  await MeshoptDecoder.ready;

  return new GLTFLoader().setKTX2Loader(ktx2Loader).setMeshoptDecoder(MeshoptDecoder);
}
