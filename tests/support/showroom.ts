import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import type { GLTF, GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import type { Catalog } from '../../src/catalog/catalog';
import { CROSSFADE_MS, MAX_FADE_STEP_MS } from '../../src/scene/crossfade';
import { createShowroom } from '../../src/scene/showroom';
import type { Showroom, ShowroomOptions } from '../../src/scene/showroom';

// Fixtures shared by the showroom unit suites: a look-shaped glTF parse carrying variant
// mappings and disposal spies, an in-memory content set behind a stubbed fetch, and the
// cross-fade drain. Each suite owns its loader doubles through vi.hoisted beside its vi.mock
// (module mocks register per file) and binds this harness to its parseAsync double.

const CONTENT_BASE = '/content';
const VARIANTS = ['base', 'light', 'dark'];
// A centred two-metre box gives the plinth a known top at one metre.
export const PLINTH_SIZE = 2;

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function lookFixture(name: string) {
  const root = new Group();
  root.name = name;
  const texture = new Texture();
  const materials = VARIANTS.map((variant) => new MeshStandardMaterial({
    name: `${name}-${variant}`,
    map: texture,
    normalMap: texture,
  }));
  const geometry = new BoxGeometry(PLINTH_SIZE, PLINTH_SIZE, PLINTH_SIZE);
  const original = new MeshStandardMaterial({ name: `${name}-original`, map: texture });
  const mannequin = new Mesh(geometry, original);
  mannequin.userData['gltfExtensions'] = {
    KHR_materials_variants: {
      mappings: materials.map((_material, index) => ({ material: index, variants: [index] })),
    },
  };
  // Resource sets must handle repeated geometry, material arrays and shared texture slots.
  const garment = new Mesh(geometry, [materials[0], materials[0]]);
  root.add(mannequin, garment);
  // Only these parser methods are used by the real variant helper.
  const parser: GLTFParser = Object.create(null);
  parser.getDependency = vi.fn(async (_type: string, index: number) => materials[index]);
  parser.assignFinalMaterial = vi.fn();
  const gltf: GLTF = Object.create(null);
  gltf.scene = root;
  gltf.parser = parser;
  gltf.userData = {
    gltfExtensions: { KHR_materials_variants: { variants: VARIANTS.map((name) => ({ name })) } },
  };
  const disposal = {
    geometry: vi.spyOn(geometry, 'dispose'),
    materials: materials.map((material) => vi.spyOn(material, 'dispose')),
    original: vi.spyOn(original, 'dispose'),
    texture: vi.spyOn(texture, 'dispose'),
  };
  return { gltf, root, geometry, mannequin, garment, materials, parser, disposal };
}

/** The parseAsync loader double each suite creates beside its vi.mock of the loaders module. */
export type ParseAsyncMock = Mock<(bytes: ArrayBuffer | string, path: string) => Promise<GLTF>>;

/**
 * Binds the harness to one suite's parseAsync double, so the in-memory content set below
 * answers the same mock that suite's hooks reset and its tests reprogram.
 */
export function createShowroomHarness(parseAsync: ParseAsyncMock) {
  function harness(
    beforeMount?: ShowroomOptions['beforeMount'],
    firstDefaultVariant?: string,
  ) {
    const catalog: Catalog = {
      version: 1,
      environment: { file: 'sky.hdr' },
      rotunda: { file: 'rotunda.glb' },
      plinth: { file: 'plinth.glb' },
      looks: ['first', 'second'].map((id) => ({
        id, name: id, description: id, thumbnail: null, file: `looks/${id}.glb`,
        variants: VARIANTS,
        defaultVariant: id === 'first' ? (firstDefaultVariant ?? 'base') : 'base',
        mannequinNode: 'mannequin',
      })),
      views: { proof: { position: [0, 2, 5], target: [0, 1, 0], fov: 45 } },
    };
    const first = lookFixture('first');
    const second = lookFixture('second');
    const rotunda = lookFixture('rotunda');
    const plinth = lookFixture('plinth');
    const files = new Map([
      ['/content/rotunda.glb', rotunda.gltf], ['/content/plinth.glb', plinth.gltf],
      ['/content/looks/first.glb', first.gltf], ['/content/looks/second.glb', second.gltf],
    ]);
    const requests: { url: string; signal: AbortSignal | null | undefined }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!files.has(url)) throw new Error(`unexpected fetch: ${url}`);
      requests.push({ url, signal: init?.signal });
      return new Response(url);
    });
    vi.stubGlobal('fetch', fetchMock);
    parseAsync.mockImplementation(async (bytes) => {
      const url = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
      const gltf = files.get(url);
      if (gltf === undefined) throw new Error(`unexpected parse: ${url}`);
      return gltf;
    });
    const renderer: WebGPURenderer = Object.create(null);
    const onChange = vi.fn();
    const decorate = vi.fn();
    const showroom = createShowroom({
      renderer,
      catalog,
      contentBase: CONTENT_BASE,
      onChange,
      decorate,
      ...(beforeMount === undefined ? {} : { beforeMount }),
    });

    function pauseFirstParse() {
      const entered = deferred<void>();
      const result = deferred<GLTF>();
      parseAsync.mockImplementationOnce(() => {
        entered.resolve();
        return result.promise;
      });
      return { entered: entered.promise, ...result };
    }
    return { showroom, first, second, rotunda, plinth, requests, fetchMock, onChange, decorate, pauseFirstParse };
  }
  return harness;
}

export async function finishFade(showroom: Showroom): Promise<void> {
  const settled = showroom.settle();
  for (let elapsed = 0; elapsed < CROSSFADE_MS; elapsed += MAX_FADE_STEP_MS) {
    showroom.update(MAX_FADE_STEP_MS);
  }
  await settled;
}
