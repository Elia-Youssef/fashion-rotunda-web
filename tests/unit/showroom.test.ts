import { BoxGeometry, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Texture } from 'three/webgpu';
import type { Material, WebGPURenderer } from 'three/webgpu';
import type { GLTF, GLTFLoader, GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Catalog } from '../../src/catalog/catalog';
import { CROSSFADE_MS, MAX_FADE_STEP_MS } from '../../src/scene/crossfade';
import { createShowroom } from '../../src/scene/showroom';
import type { Showroom, ShowroomOptions } from '../../src/scene/showroom';

const { createGltfLoader, parseAsync } = vi.hoisted(() => ({
  createGltfLoader: vi.fn<() => Promise<GLTFLoader>>(),
  parseAsync: vi.fn<(bytes: ArrayBuffer | string, path: string) => Promise<GLTF>>(),
}));

vi.mock('../../src/scene/loaders', () => ({ createGltfLoader }));

const CONTENT_BASE = '/content';
const VARIANTS = ['base', 'light', 'dark'];
// A centred two-metre box gives the plinth a known top at one metre.
const PLINTH_SIZE = 2;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/**
 * One macrotask boundary: every microtask chain the tests start (parser resolutions, ownership
 * handoffs) has drained by the time it resolves, without depending on how many hops each has.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
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

function harness(beforeMount?: ShowroomOptions['beforeMount']) {
  const catalog: Catalog = {
    version: 1,
    environment: { file: 'sky.hdr' },
    rotunda: { file: 'rotunda.glb' },
    plinth: { file: 'plinth.glb' },
    looks: ['first', 'second'].map((id) => ({
      id, name: id, description: id, thumbnail: null, file: `looks/${id}.glb`,
      variants: VARIANTS, defaultVariant: 'base', mannequinNode: 'mannequin',
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

async function finishFade(showroom: Showroom): Promise<void> {
  const settled = showroom.settle();
  for (let elapsed = 0; elapsed < CROSSFADE_MS; elapsed += MAX_FADE_STEP_MS) {
    showroom.update(MAX_FADE_STEP_MS);
  }
  await settled;
}

beforeEach(() => {
  vi.resetAllMocks();
  const loader: GLTFLoader = Object.create(null);
  loader.parseAsync = parseAsync;
  createGltfLoader.mockResolvedValue(loader);
  vi.stubGlobal('window', { matchMedia: vi.fn(() => ({ matches: false })) });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  performance.clearMarks('look-switch-start');
  performance.clearMeasures('look-switch');
});

describe('createShowroom', () => {
  it('loads each static once at startup and retains it through look switches', async () => {
    const { showroom, rotunda, plinth, first, second, requests, decorate } = harness();
    await showroom.loadStatics();
    await showroom.showLook('first');
    await showroom.showLook('second');
    await finishFade(showroom);

    expect(requests.map(({ url }) => url)).toEqual([
      '/content/rotunda.glb', '/content/plinth.glb',
      '/content/looks/first.glb', '/content/looks/second.glb',
    ]);
    expect(createGltfLoader).toHaveBeenCalledTimes(1);
    expect(parseAsync.mock.calls.map(([, directory]) => directory)).toEqual([
      '/content/', '/content/', '/content/looks/', '/content/looks/',
    ]);
    expect(rotunda.root.parent).toBe(showroom.scene);
    expect(plinth.root.parent).toBe(second.root.parent);
    expect(showroom.turntableState.plinthAttached).toBe(true);
    expect(second.root.position.y).toBe(PLINTH_SIZE / 2);
    expect(first.root.parent).toBeNull();
    expect(decorate.mock.calls.map(([root]) => root)).toEqual([
      rotunda.root, plinth.root, first.root, second.root,
    ]);
    expect(rotunda.disposal.geometry).not.toHaveBeenCalled();
    expect(plinth.disposal.geometry).not.toHaveBeenCalled();
  });

  it('keeps the latest overlapping request and disposes a stale parsed look', async () => {
    const { showroom, first, second, requests, onChange, pauseFirstParse } = harness();
    const parse = pauseFirstParse();
    const older = showroom.showLook('first');
    await parse.entered;
    await showroom.showLook('second');
    // Parsing is already past fetch and still resolves after its signal is aborted.
    parse.resolve(first.gltf);
    await older;

    expect(showroom.currentLook).toBe('second');
    expect(requests[0].signal?.aborted).toBe(true);
    expect(requests[1].signal?.aborted).toBe(false);
    expect(second.root.parent).not.toBeNull();
    expect(first.root.parent).toBeNull();
    expect(first.disposal.geometry).toHaveBeenCalledTimes(1);
    expect(first.disposal.materials[0]).toHaveBeenCalledTimes(1);
    expect(first.disposal.original).toHaveBeenCalledTimes(1);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);
    expect(second.disposal.geometry).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('disposes replaced geometry, original and variant materials, and shared textures after the fade', async () => {
    const { showroom, first, second } = harness();
    await showroom.showLook('first');
    await showroom.setVariant('light');
    await showroom.setVariant('dark');
    await showroom.showLook('second');
    expect(showroom.fading).toBe(true);
    expect(first.root.parent).toBe(second.root.parent);
    expect(first.disposal.geometry).not.toHaveBeenCalled();
    for (const dispose of first.disposal.materials) expect(dispose).not.toHaveBeenCalled();
    expect(first.disposal.original).not.toHaveBeenCalled();
    expect(first.disposal.texture).not.toHaveBeenCalled();

    await finishFade(showroom);
    showroom.update(MAX_FADE_STEP_MS);

    expect(showroom.fading).toBe(false);
    expect(first.root.parent).toBeNull();
    expect(first.disposal.geometry).toHaveBeenCalledTimes(1);
    for (const dispose of first.disposal.materials) expect(dispose).toHaveBeenCalledTimes(1);
    expect(first.disposal.original).toHaveBeenCalledTimes(1);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);
    expect(second.root.parent).not.toBeNull();
    expect(second.disposal.geometry).not.toHaveBeenCalled();
    for (const dispose of second.disposal.materials) expect(dispose).not.toHaveBeenCalled();
    expect(second.disposal.original).not.toHaveBeenCalled();
    expect(second.disposal.texture).not.toHaveBeenCalled();
  });

  it('applies a variant to the current incoming look while leaving the outgoing look alone', async () => {
    const { showroom, first, second } = harness();
    await showroom.showLook('first');
    await showroom.showLook('second');
    expect(showroom.fading).toBe(true);
    await showroom.setVariant('light');

    expect(showroom.currentLook).toBe('second');
    expect(showroom.currentVariant).toBe('light');
    expect(second.mannequin.material).toBe(second.materials[1]);
    expect(second.garment.material).toEqual([second.materials[0], second.materials[0]]);
    expect(first.mannequin.material).toBe(first.materials[0]);
    expect(first.parser.getDependency).toHaveBeenCalledTimes(1);
    expect(second.parser.getDependency).toHaveBeenLastCalledWith('material', 1);
    await finishFade(showroom);
  });

  it('rejects an unknown look before fetching or changing the scene', async () => {
    const { showroom, fetchMock, onChange } = harness();
    await expect(showroom.showLook('missing')).rejects.toThrow(
      'no look with the id "missing" in the catalogue',
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(showroom.currentLook).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects variant selection without a look on screen', async () => {
    const { showroom, onChange } = harness();
    await expect(showroom.setVariant('light')).rejects.toThrow(
      'setVariant("light") needs a look on screen',
    );
    expect(showroom.currentVariant).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects an unavailable variant without changing the material or selected variant', async () => {
    const { showroom, first, onChange } = harness();
    await showroom.showLook('first');
    await expect(showroom.setVariant('missing')).rejects.toThrow(
      'the look "first" has no variant "missing"',
    );
    expect(first.mannequin.material).toBe(first.materials[0]);
    expect(first.parser.getDependency).toHaveBeenCalledTimes(1);
    expect(showroom.currentVariant).toBe('base');
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('reports a static HTTP failure without attaching partial statics', async () => {
    const { showroom, rotunda, plinth, fetchMock, onChange } = harness();
    // The response status is part of the public error message, not a timing or a budget.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(showroom.loadStatics()).rejects.toThrow('content: /content/rotunda.glb answered 503');
    expect(rotunda.root.parent).toBeNull();
    expect(plinth.root.parent).toBeNull();
    expect(showroom.turntableState.plinthAttached).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports a current look HTTP failure, preserves the visible look, and permits a retry', async () => {
    const { showroom, first, second, fetchMock, onChange } = harness();
    await showroom.showLook('first');
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(showroom.showLook('second')).rejects.toThrow(
      'content: /content/looks/second.glb answered 404',
    );
    expect(showroom.currentLook).toBe('first');
    expect(first.root.parent).not.toBeNull();
    expect(first.disposal.geometry).not.toHaveBeenCalled();
    expect(showroom.fading).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);

    await showroom.showLook('second');
    expect(showroom.currentLook).toBe('second');
    expect(second.root.parent).not.toBeNull();
    await finishFade(showroom);
  });

  it('propagates a current parser error without replacing the visible look', async () => {
    const { showroom, first, onChange } = harness();
    await showroom.showLook('first');
    const failure = new Error('invalid glTF');
    parseAsync.mockRejectedValueOnce(failure);
    await expect(showroom.showLook('second')).rejects.toBe(failure);
    expect(showroom.currentLook).toBe('first');
    expect(first.root.parent).not.toBeNull();
    expect(first.disposal.geometry).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('resolves a superseded parser failure while keeping the winning look', async () => {
    const { showroom, second, onChange, pauseFirstParse } = harness();
    const parse = pauseFirstParse();
    const older = showroom.showLook('first');
    await parse.entered;
    await showroom.showLook('second');
    const resolved = expect(older).resolves.toBeUndefined();
    parse.reject(new Error('retired parse failed'));
    await resolved;
    expect(showroom.currentLook).toBe('second');
    expect(second.root.parent).not.toBeNull();
    expect(second.disposal.geometry).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('releases a variant that resolves after its look retired, without touching the incoming look', async () => {
    const { showroom, first, second } = harness();
    await showroom.showLook('first');
    // Hold the swatch lookup in the parser, past the switch and the whole outgoing fade.
    const late = deferred<Material>();
    vi.mocked(first.parser.getDependency).mockImplementationOnce(() => late.promise);
    const swatch = showroom.setVariant('light');
    await showroom.showLook('second');
    await finishFade(showroom);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);

    late.resolve(first.materials[1]);
    await swatch;

    expect(showroom.currentLook).toBe('second');
    // The incoming look's variant state is not the retired look's to overwrite.
    expect(showroom.currentVariant).toBe('base');
    // Nothing was committed onto the detached root.
    expect(first.mannequin.material).toBe(first.materials[0]);
    expect(first.parser.assignFinalMaterial).toHaveBeenCalledTimes(1);
    // The material the late swap resolved, and its texture, are freed exactly once.
    expect(first.disposal.materials[1]).toHaveBeenCalledTimes(1);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);
    expect(second.disposal.geometry).not.toHaveBeenCalled();
  });

  it('ignores a swatch that resolves for the outgoing look mid-fade, and frees its material at fade end', async () => {
    const { showroom, first } = harness();
    await showroom.showLook('first');
    const late = deferred<Material>();
    vi.mocked(first.parser.getDependency).mockImplementationOnce(() => late.promise);
    const swatch = showroom.setVariant('light');
    await showroom.showLook('second');
    // Inside the cross-fade window: the switch already took effect (onReady ran), the fade runs.
    expect(showroom.fading).toBe(true);

    late.resolve(first.materials[1]);
    await swatch;

    // The variant state the showroom reports is the incoming look's, not the leaving look's.
    expect(showroom.currentVariant).toBe('base');
    // The outgoing look's meshes keep the material they had; nothing new is committed onto them.
    expect(first.mannequin.material).toBe(first.materials[0]);
    expect(first.parser.assignFinalMaterial).toHaveBeenCalledTimes(1);
    // The fade has not released the outgoing look yet, so the late material is owned but alive.
    expect(first.disposal.materials[1]).not.toHaveBeenCalled();

    await finishFade(showroom);

    // Released with the outgoing look at fade end, exactly once.
    expect(first.disposal.materials[1]).toHaveBeenCalledTimes(1);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);
    expect(showroom.currentVariant).toBe('base');
  });

  it('owns the finalized clone when a later mesh rejects, disposing it with the look', async () => {
    const { showroom, first } = harness();
    await showroom.showLook('first');
    // The parser's finalizer replaces the assigned material with a clone it caches; the second
    // mapped mesh makes the swatch span two parser resolutions.
    const clone = new MeshStandardMaterial({ name: 'finalized-clone' });
    const cloneDispose = vi.spyOn(clone, 'dispose');
    const extra = new Mesh(first.geometry, first.materials[0]);
    extra.userData['gltfExtensions'] = {
      KHR_materials_variants: { mappings: [{ material: 2, variants: [2] }] },
    };
    first.root.add(extra);
    first.parser.assignFinalMaterial = vi.fn((mesh: Mesh): void => {
      if (mesh === first.mannequin) {
        mesh.material = clone;
      }
    });
    const failure = new Error('second resolution failed');
    const fixtureDependency = first.parser.getDependency;
    let resolutions = 0;
    first.parser.getDependency = vi.fn((type: string, index: number): Promise<Material> => {
      resolutions += 1;
      if (resolutions === 2) {
        return Promise.reject(failure);
      }
      return fixtureDependency(type, index);
    });

    await expect(showroom.setVariant('dark')).rejects.toBe(failure);
    expect(first.mannequin.material).toBe(clone);

    await showroom.showLook('second');
    await finishFade(showroom);

    expect(cloneDispose).toHaveBeenCalledTimes(1);
    expect(first.disposal.materials[2]).toHaveBeenCalledTimes(1);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);
  });

  it('owns the finalized clone when the look is superseded mid-swap, dissolving and freeing it', async () => {
    const { showroom, first } = harness();
    await showroom.showLook('first');
    const clone = new MeshStandardMaterial({ name: 'finalized-clone' });
    const cloneDispose = vi.spyOn(clone, 'dispose');
    const extra = new Mesh(first.geometry, first.materials[0]);
    extra.userData['gltfExtensions'] = {
      KHR_materials_variants: { mappings: [{ material: 2, variants: [2] }] },
    };
    first.root.add(extra);
    first.parser.assignFinalMaterial = vi.fn((mesh: Mesh): void => {
      if (mesh === first.mannequin) {
        mesh.material = clone;
      }
    });
    const held = deferred<Material>();
    const fixtureDependency = first.parser.getDependency;
    let resolutions = 0;
    first.parser.getDependency = vi.fn((type: string, index: number): Promise<Material> => {
      resolutions += 1;
      return resolutions === 2 ? held.promise : fixtureDependency(type, index);
    });

    const swatch = showroom.setVariant('dark');
    await showroom.showLook('second');
    // The clone joined the look's material set before the fade started, so the dissolve stamped
    // it: no opaque mesh while the rest of the look fades out.
    const stamp = (material: Material): { opacity: unknown; alphaTest: unknown } => {
      const fade = material as Material & { opacityNode?: unknown; alphaTestNode?: unknown };
      return { opacity: fade.opacityNode, alphaTest: fade.alphaTestNode };
    };
    // The same live uniform as the rest of the outgoing look, not merely some value.
    expect(stamp(clone).opacity ?? null).not.toBeNull();
    expect(stamp(clone)).toEqual(stamp(first.materials[0]));
    expect(stamp(clone).opacity).toBe(stamp(first.materials[0]).opacity);

    held.resolve(first.materials[2]);
    await swatch;

    expect(first.mannequin.material).toBe(clone);
    expect(extra.material).toBe(first.materials[0]);
    await finishFade(showroom);

    expect(cloneDispose).toHaveBeenCalledTimes(1);
    expect(first.disposal.materials[2]).toHaveBeenCalledTimes(1);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);
  });

  it('frees a static upgrade when the other static\'s tuning throws', async () => {
    const { showroom, rotunda, plinth } = harness();
    const physicalDispose = vi.spyOn(MeshPhysicalMaterial.prototype, 'dispose');
    // The rotunda's single-material mesh carries a tuned name, so tuning upgrades it in place;
    // the plinth's material-array mesh carries one too, so its tuning step throws.
    const rotundaOriginal = rotunda.mannequin.material as MeshStandardMaterial;
    rotundaOriginal.name = 'MI_Metal_Brass_02';
    plinth.materials[0].name = 'MI_Metal_Brass_02';
    await expect(showroom.loadStatics()).rejects.toThrow('material tuning needs one material per mesh');
    await flush();

    // The upgraded physical instance is owned and released with the failed pair, not just the
    // parse-time snapshot both roots were collected at.
    expect(physicalDispose).toHaveBeenCalledTimes(1);
    expect(rotunda.disposal.geometry).toHaveBeenCalledTimes(1);
    expect(rotunda.disposal.original).toHaveBeenCalledTimes(1);
    expect(rotunda.disposal.materials[0]).toHaveBeenCalledTimes(1);
    expect(rotunda.disposal.texture).toHaveBeenCalledTimes(1);
    expect(plinth.disposal.geometry).toHaveBeenCalledTimes(1);
    expect(plinth.disposal.materials[0]).toHaveBeenCalledTimes(1);
    expect(plinth.disposal.original).toHaveBeenCalledTimes(1);
    expect(plinth.disposal.texture).toHaveBeenCalledTimes(1);
    expect(showroom.turntableState.plinthAttached).toBe(false);
  });

  it('frees the parsed static when its sibling load fails', async () => {
    const { showroom, rotunda, plinth, fetchMock } = harness();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(showroom.loadStatics()).rejects.toThrow('content: /content/rotunda.glb answered 503');
    await flush();

    // The plinth parsed while the rotunda failed; its resources are released, not retained.
    expect(plinth.disposal.geometry).toHaveBeenCalledTimes(1);
    expect(plinth.disposal.materials[0]).toHaveBeenCalledTimes(1);
    expect(plinth.disposal.original).toHaveBeenCalledTimes(1);
    expect(plinth.disposal.texture).toHaveBeenCalledTimes(1);
    // The rotunda never parsed, so there is nothing of its own to free.
    expect(rotunda.disposal.geometry).not.toHaveBeenCalled();
    expect(showroom.turntableState.plinthAttached).toBe(false);
  });

  it('frees a static that finishes parsing after the pair already failed', async () => {
    const { showroom, plinth, pauseFirstParse } = harness();
    const failure = new Error('rotunda parse failed');
    parseAsync.mockRejectedValueOnce(failure);
    // The rotunda's parse rejects; the plinth's is the first call held open here. The rejection
    // expectation is attached at once: the failure lands during the flush below.
    const held = pauseFirstParse();
    const failing = expect(showroom.loadStatics()).rejects.toBe(failure);
    await flush();
    expect(showroom.turntableState.plinthAttached).toBe(false);

    held.resolve(plinth.gltf);
    await failing;
    await flush();

    expect(plinth.disposal.geometry).toHaveBeenCalledTimes(1);
    expect(plinth.disposal.materials[0]).toHaveBeenCalledTimes(1);
    expect(plinth.disposal.original).toHaveBeenCalledTimes(1);
    expect(plinth.disposal.texture).toHaveBeenCalledTimes(1);
  });

  it('releases every acquired resource when a look\'s initial variant rejects', async () => {
    const { showroom, first, onChange } = harness();
    const failure = new Error('variant dependency failed');
    vi.mocked(first.parser.getDependency).mockImplementationOnce(() => Promise.reject(failure));
    await expect(showroom.showLook('first')).rejects.toBe(failure);

    expect(showroom.currentLook).toBeNull();
    expect(first.root.parent).toBeNull();
    expect(first.disposal.geometry).toHaveBeenCalledTimes(1);
    expect(first.disposal.original).toHaveBeenCalledTimes(1);
    expect(first.disposal.materials[0]).toHaveBeenCalledTimes(1);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('releases the parsed look when tuning throws', async () => {
    const { showroom, first } = harness();
    // A tuned table name on the garment's material makes applyTuning reject the material array.
    first.materials[0].name = 'MI_Metal_Brass_02';
    await expect(showroom.showLook('first')).rejects.toThrow(
      'material tuning needs one material per mesh',
    );

    expect(first.disposal.geometry).toHaveBeenCalledTimes(1);
    expect(first.disposal.original).toHaveBeenCalledTimes(1);
    expect(first.disposal.materials[0]).toHaveBeenCalledTimes(1);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);
  });

  it('keeps a partially applied variant owned so its materials are freed with the look', async () => {
    const { showroom, first } = harness();
    // A second mapped mesh makes one swatch span two parser resolutions.
    const extra = new Mesh(first.geometry, first.materials[0]);
    extra.userData['gltfExtensions'] = {
      KHR_materials_variants: { mappings: [{ material: 2, variants: [2] }] },
    };
    first.root.add(extra);
    await showroom.showLook('first');
    const failure = new Error('second resolution failed');
    const fixtureDependency = first.parser.getDependency;
    let resolutions = 0;
    first.parser.getDependency = vi.fn((type: string, index: number): Promise<Material> => {
      resolutions += 1;
      if (resolutions === 2) {
        return Promise.reject(failure);
      }
      return fixtureDependency(type, index);
    });

    await expect(showroom.setVariant('dark')).rejects.toBe(failure);
    // The failed swap leaves the state it reached; the point is that nothing escapes ownership.
    expect(showroom.currentVariant).toBe('base');
    expect(first.mannequin.material).toBe(first.materials[2]);

    await showroom.showLook('second');
    await finishFade(showroom);

    expect(first.disposal.materials[2]).toHaveBeenCalledTimes(1);
    expect(first.disposal.materials[0]).toHaveBeenCalledTimes(1);
    expect(first.disposal.original).toHaveBeenCalledTimes(1);
    expect(first.disposal.geometry).toHaveBeenCalledTimes(1);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);
  });

  it('releases a look whose mount prerequisite fails', async () => {
    const beforeMount: ShowroomOptions['beforeMount'] = async (kind) => {
      if (kind === 'look') {
        throw new Error('prerequisite failed');
      }
    };
    const { showroom, first } = harness(beforeMount);
    await expect(showroom.showLook('first')).rejects.toThrow('prerequisite failed');

    expect(first.disposal.geometry).toHaveBeenCalledTimes(1);
    expect(first.disposal.original).toHaveBeenCalledTimes(1);
    expect(first.disposal.materials[0]).toHaveBeenCalledTimes(1);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);
    expect(first.root.parent).toBeNull();
  });
});
