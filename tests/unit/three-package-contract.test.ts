import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('three package compatibility contracts', () => {
  it('resolves the runtime addon deep and entry point exports used by the showroom', async () => {
    const surfaces: Record<string, string[]> = {
      'three/webgpu': [
        'TextureSource', 'ViewportTextureNode', 'RectAreaLightNode', 'PMREMGenerator',
        'RenderPipeline', 'WebGPURenderer', 'Data3DTexture', 'ACESFilmicToneMapping',
      ],
      'three/tsl': [
        'hash', 'screenCoordinate', 'builtinAOContext', 'convertToTexture', 'float',
        'materialMetalness', 'materialRoughness', 'mix', 'mrt', 'normalView', 'output',
        'pass', 'renderOutput', 'screenUV', 'smoothstep', 'texture3D', 'uniform',
        'vec2', 'vec4', 'velocity', 'luminance', 'materialColor',
      ],
      'three/addons/loaders/GLTFLoader.js': ['GLTFLoader'],
      'three/addons/loaders/KTX2Loader.js': ['KTX2Loader'],
      'three/addons/libs/meshopt_decoder.module.js': ['MeshoptDecoder'],
      'three/addons/tsl/display/GTAONode.js': ['default', 'ao'],
      'three/addons/tsl/display/TRAANode.js': ['default', 'traa'],
      'three/addons/tsl/display/SSRNode.js': ['default', 'ssr'],
      'three/addons/tsl/display/SSGINode.js': ['default', 'ssgi'],
      'three/addons/tsl/display/BloomNode.js': ['default', 'bloom'],
      'three/addons/tsl/display/Lut3DNode.js': ['default', 'lut3D'],
      'three/addons/tsl/display/DepthOfFieldNode.js': ['default', 'dof'],
      'three/addons/lights/RectAreaLightTexturesLib.js': ['RectAreaLightTexturesLib'],
      'three/addons/environments/RoomEnvironment.js': ['RoomEnvironment'],
      'three/addons/loaders/HDRLoader.js': ['HDRLoader'],
      'three/src/nodes/utils/RTTNode.js': ['default'],
      'three/src/renderers/webgpu/nodes/StandardNodeLibrary.js': ['default'],
      '@gltf-transform/cli': ['Mode', 'toktx'],
    };
    for (const [path, names] of Object.entries(surfaces)) {
      const module = await import(path) as Record<string, unknown>;
      for (const name of names) expect(module[name], `${path}:${name}`).toBeDefined();
    }
  });

  it('pairs both served Basis transcoder files with the installed loader package', () => {
    for (const file of ['basis_transcoder.js', 'basis_transcoder.wasm']) {
      const installed = readFileSync(join('node_modules/three/examples/jsm/libs/basis', file));
      const served = readFileSync(join('public/content/basis', file));
      expect(served.equals(installed), `${file} must match the installed three package`).toBe(true);
    }
  });
});
