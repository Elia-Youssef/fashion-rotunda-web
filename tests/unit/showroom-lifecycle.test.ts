import { BoxGeometry, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Texture } from 'three/webgpu';
import type { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FADE_STEP_MS } from '../../src/scene/crossfade';
import { createShowroomHarness, finishFade, PLINTH_SIZE } from '../support/showroom';

// The happy path of loading and replacement: statics load once and stay through look switches,
// the latest overlapping request wins, and a replaced look's resources go at the fade's end.

const { createGltfLoader, parseAsync } = vi.hoisted(() => ({
  createGltfLoader: vi.fn<() => Promise<GLTFLoader>>(),
  parseAsync: vi.fn<(bytes: ArrayBuffer | string, path: string) => Promise<GLTF>>(),
}));

vi.mock('../../src/scene/loaders', () => ({ createGltfLoader }));

const harness = createShowroomHarness(parseAsync);

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

  it('retires initial displaced materials with the look', async () => {
    const { showroom, first } = harness();
    const physicalDispose = vi.spyOn(MeshPhysicalMaterial.prototype, 'dispose');
    // The mannequin arrives from the parser in a tuned standard material, and the load tunes
    // it before anything collects the meshes, so the displaced original is owned only through
    // the handoff the tuning itself makes.
    (first.mannequin.material as MeshStandardMaterial).name = 'MI_Metal_Brass_02';
    await showroom.showLook('first');
    // The default swatch swap parked the upgrade and put the base variant on the mesh.
    expect(first.mannequin.material).toBe(first.materials[0]);
    expect(first.mannequin.userData['originalMaterial']).toBeInstanceOf(MeshPhysicalMaterial);

    await showroom.showLook('second');
    await finishFade(showroom);

    // The displaced parse original goes with the look it was displaced from, the parked
    // upgrade with it, and the shared texture exactly once.
    expect(first.disposal.original).toHaveBeenCalledTimes(1);
    expect(physicalDispose).toHaveBeenCalledTimes(1);
    expect(first.disposal.materials[0]).toHaveBeenCalledTimes(1);
    expect(first.disposal.geometry).toHaveBeenCalledTimes(1);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);
  });

  it('disposes a shared displaced material and its shared texture exactly once', async () => {
    const { showroom, first } = harness();
    // One material instance behind two meshes, the way one glTF material index shared by two
    // primitives parses: each mesh is handed its own upgrade, the shared original twice.
    const texture = new Texture();
    const textureDispose = vi.spyOn(texture, 'dispose');
    const shared = new MeshStandardMaterial({
      name: 'MI_Metal_Brass_02',
      map: texture,
      normalMap: texture,
    });
    const sharedDispose = vi.spyOn(shared, 'dispose');
    const one = new Mesh(new BoxGeometry(), shared);
    const two = new Mesh(new BoxGeometry(), shared);
    first.root.add(one, two);

    await showroom.showLook('first');
    expect(one.material).toBeInstanceOf(MeshPhysicalMaterial);
    expect(two.material).toBeInstanceOf(MeshPhysicalMaterial);
    expect(one.material).not.toBe(two.material);

    await showroom.showLook('second');
    await finishFade(showroom);

    expect(sharedDispose).toHaveBeenCalledTimes(1);
    // The texture rides the displaced original and both upgrades; it is one resource.
    expect(textureDispose).toHaveBeenCalledTimes(1);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);
  });
});
