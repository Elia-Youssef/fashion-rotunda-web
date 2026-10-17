import { BoxGeometry, Color, Group, Mesh, MeshStandardMaterial, Texture, Vector3 } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import type { GLTF, GLTFLoader, GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Catalog, CatalogLook } from '../../src/catalog/catalog';
import { CROSSFADE_MS, MAX_FADE_STEP_MS } from '../../src/scene/crossfade';
import { createShowroom, SCENE_BACKGROUND } from '../../src/scene/showroom';
import { createShowroomHarness, finishFade, PLINTH_SIZE } from '../support/showroom';

// Contracts the fault sweep found unguarded: the published switch timing, the frame invalidations,
// the camera and clear colour the caller renders with, the dev-only material log, the turntable
// state, the fade's opacity and shadow choreography, the viewport aspect guard and the variant a
// later look arrives on when the visitor already chose a swatch.

const { createGltfLoader, parseAsync } = vi.hoisted(() => ({
  createGltfLoader: vi.fn<() => Promise<GLTFLoader>>(),
  parseAsync: vi.fn<(bytes: ArrayBuffer | string, path: string) => Promise<GLTF>>(),
}));

vi.mock('../../src/scene/loaders', () => ({ createGltfLoader }));

const harness = createShowroomHarness(parseAsync);

function lookFixture(name: string, variants: string[]) {
  const root = new Group();
  root.name = name;
  const texture = new Texture();
  const materials = variants.map((variant) => new MeshStandardMaterial({
    name: `${name}-${variant}`,
    map: texture,
  }));
  const geometry = new BoxGeometry(PLINTH_SIZE, PLINTH_SIZE, PLINTH_SIZE);
  const original = new MeshStandardMaterial({ name: `${name}-original`, map: texture });
  const mannequin = new Mesh(geometry, original);
  mannequin.userData['gltfExtensions'] = {
    KHR_materials_variants: {
      mappings: variants.map((_name, index) => ({ material: index, variants: [index] })),
    },
  };
  root.add(mannequin);
  const parser: GLTFParser = Object.create(null);
  parser.getDependency = vi.fn(async (_type: string, index: number) => materials[index]);
  parser.assignFinalMaterial = vi.fn();
  const gltf: GLTF = Object.create(null);
  gltf.scene = root;
  gltf.parser = parser;
  gltf.userData = {
    gltfExtensions: { KHR_materials_variants: { variants: variants.map((v) => ({ name: v })) } },
  };
  return { gltf, root, mannequin, materials, parser };
}

/**
 * A content set with one look that does not offer every swatch, for the fallback the variant
 * picker owes a look the visitor's choice cannot reach.
 */
function narrowHarness() {
  const first = lookFixture('first', ['base', 'light', 'dark']);
  const narrow = lookFixture('narrow', ['base', 'dark']);
  const look = (id: string, file: string, variants: string[]): CatalogLook => ({
    id, name: id, description: id, thumbnail: null, file,
    variants, defaultVariant: 'base', mannequinNode: 'mannequin',
  });
  const catalog: Catalog = {
    version: 1,
    environment: { file: 'sky.hdr' },
    rotunda: { file: 'rotunda.glb' },
    plinth: { file: 'plinth.glb' },
    looks: [look('first', 'looks/first.glb', ['base', 'light', 'dark']),
      look('narrow', 'looks/narrow.glb', ['base', 'dark'])],
    views: { proof: { position: [0, 2, 5], target: [0, 1, 0], fov: 45 } },
  };
  const files = new Map([
    ['/content/looks/first.glb', first.gltf],
    ['/content/looks/narrow.glb', narrow.gltf],
  ]);
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!files.has(url)) throw new Error(`unexpected fetch: ${url}`);
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
  const showroom = createShowroom({
    renderer, catalog, contentBase: '/content', onChange,
  });
  return { showroom, first, narrow };
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

describe('createShowroom contracts', () => {
  it('renders with the exported clear colour and a camera built from the proof view', () => {
    const { showroom } = harness();

    expect(showroom.scene.background).toBeInstanceOf(Color);
    expect((showroom.scene.background as Color).getHex()).toBe(SCENE_BACKGROUND);

    // The proof view the shared fixture catalog carries: position [0, 2, 5], target [0, 1, 0],
    // fov 45. The room is 16 m across, so near 0.05 and far 120 bound it with room to spare.
    expect(showroom.camera.fov).toBe(45);
    expect(showroom.camera.near).toBe(0.05);
    expect(showroom.camera.far).toBe(120);
    expect(showroom.camera.position.x).toBe(0);
    expect(showroom.camera.position.y).toBe(2);
    expect(showroom.camera.position.z).toBe(5);
    const direction = showroom.camera.getWorldDirection(new Vector3());
    const towardTarget = new Vector3(0, 1, 0).sub(new Vector3(0, 2, 5)).normalize();
    expect(direction.x).toBeCloseTo(towardTarget.x, 5);
    expect(direction.y).toBeCloseTo(towardTarget.y, 5);
    expect(direction.z).toBeCloseTo(towardTarget.z, 5);
  });

  it('logs each file\'s material classes once, with every distinct material of every mesh', async () => {
    const { showroom, first } = harness();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await showroom.showLook('first');

    const calls = log.mock.calls.filter(([head]) => String(head).includes('material classes'));
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('[archviz] material classes for looks/first.glb:');
    // The mannequin wears the parse original; the garment wears one shared material in an array,
    // which counts once, so the file's classes are exactly these two rows.
    expect(calls[0][1]).toEqual([
      { material: 'first-original', type: 'MeshStandardMaterial' },
      { material: 'first-base', type: 'MeshStandardMaterial' },
    ]);

    await showroom.showLook('second');
    await finishFade(showroom);
    await showroom.showLook('first');

    const repeats = log.mock.calls.filter(([head]) =>
      String(head) === '[archviz] material classes for looks/first.glb:');
    expect(repeats).toHaveLength(1);
    expect(first.root.parent).not.toBeNull();
  });

  it('stands a look at floor height until the plinth is measured, then lifts it', async () => {
    const { showroom, first } = harness();

    await showroom.showLook('first');
    expect(first.root.position.y).toBe(0);

    await showroom.loadStatics();
    expect(first.root.position.y).toBe(PLINTH_SIZE / 2);
  });

  it('carries the chosen swatch to every later look that offers it', async () => {
    const { showroom, second } = harness();

    await showroom.showLook('first');
    await showroom.setVariant('light');
    await showroom.showLook('second');

    expect(showroom.currentVariant).toBe('light');
    expect(second.mannequin.material).toBe(second.materials[1]);
    await finishFade(showroom);
  });

  it('falls back to a look\'s default swatch when it does not offer the chosen one', async () => {
    const { showroom, narrow } = narrowHarness();

    await showroom.showLook('first');
    await showroom.setVariant('light');
    await showroom.showLook('narrow');

    expect(showroom.currentVariant).toBe('base');
    expect(narrow.mannequin.material).toBe(narrow.materials[0]);
  });

  it('marks exactly the requests that are switches and times them at the first faded frame', async () => {
    const { showroom, first, pauseFirstParse } = harness();
    const marks = (): number => performance.getEntriesByName('look-switch-start').length;

    expect(showroom.lastSwitchMs).toBeNull();
    await showroom.showLook('first');
    expect(marks()).toBe(1);
    await showroom.showLook('second');
    expect(marks()).toBe(2);
    // Re-clicking the look on screen, or the look already coming, moves no mark: the running
    // measure must keep the start its visitor experienced.
    await showroom.showLook('second');
    expect(marks()).toBe(2);
    await expect(showroom.showLook('missing')).rejects.toThrow(
      'no look with the id "missing" in the catalogue',
    );
    expect(marks()).toBe(2);
    expect(showroom.lastSwitchMs).toBeNull();

    showroom.update(MAX_FADE_STEP_MS);
    expect(showroom.lastSwitchMs).not.toBeNull();
    expect(showroom.lastSwitchMs as number).toBeGreaterThanOrEqual(0);
    await finishFade(showroom);

    const parse = pauseFirstParse();
    const pending = showroom.showLook('first');
    await parse.entered;
    expect(marks()).toBe(3);
    const again = showroom.showLook('first');
    expect(marks()).toBe(3);
    parse.resolve(first.gltf);
    await pending;
    await again;
    await finishFade(showroom);
  });

  it('dissolves the outgoing look by the fade arithmetic', async () => {
    const { showroom, first } = harness();
    await showroom.showLook('first');
    await showroom.showLook('second');
    expect(showroom.fading).toBe(true);

    showroom.update(MAX_FADE_STEP_MS);
    const fade = first.mannequin.material as typeof first.mannequin.material & {
      opacityNode?: { value: number };
    };
    expect(fade.opacityNode?.value).toBeCloseTo(1 - MAX_FADE_STEP_MS / CROSSFADE_MS, 5);
    await finishFade(showroom);
  });

  it('holds the sun on the outgoing look for the fade\'s first half, then hands it over', async () => {
    const { showroom, first, second } = harness();
    for (const mesh of [first.mannequin, first.garment, second.mannequin, second.garment]) {
      mesh.castShadow = true;
    }

    await showroom.showLook('first');
    await showroom.showLook('second');
    expect(showroom.fading).toBe(true);
    // One caster per frame: the arriving look is parked while the leaving one still casts.
    expect(second.mannequin.castShadow).toBe(false);
    expect(first.mannequin.castShadow).toBe(true);

    showroom.update(MAX_FADE_STEP_MS);
    showroom.update(MAX_FADE_STEP_MS);
    showroom.update(MAX_FADE_STEP_MS);
    expect(first.mannequin.castShadow).toBe(false);
    expect(second.mannequin.castShadow).toBe(true);

    await finishFade(showroom);
    expect(second.mannequin.castShadow).toBe(true);
    expect(first.mannequin.castShadow).toBe(false);
  });

  it('resolves settle at once when no fade runs and only after an interrupted fade ends', async () => {
    const { showroom } = harness();
    let idle = false;
    void showroom.settle().then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(idle).toBe(true);

    await showroom.showLook('first');
    await showroom.showLook('second');
    let settled = false;
    const done = showroom.settle().then(() => {
      settled = true;
    });
    // The interrupt ends the first fade and starts a second in one run; the waiter must outlive
    // both, or it reports the screen settled while a look is still dissolving.
    await showroom.showLook('first');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    await finishFade(showroom);
    await done;
    expect(settled).toBe(true);
  });

  it('invalidates a frame for every change a visitor can see', async () => {
    const { showroom, onChange } = harness();
    expect(onChange).toHaveBeenCalledTimes(0);

    await showroom.loadStatics();
    expect(onChange).toHaveBeenCalledTimes(1);
    await showroom.showLook('first');
    expect(onChange).toHaveBeenCalledTimes(2);
    await showroom.setVariant('light');
    expect(onChange).toHaveBeenCalledTimes(3);
    showroom.setLookYaw(0.5);
    expect(onChange).toHaveBeenCalledTimes(4);
    await showroom.showLook('second');
    expect(onChange).toHaveBeenCalledTimes(5);
    showroom.update(MAX_FADE_STEP_MS);
    expect(onChange).toHaveBeenCalledTimes(6);
    await finishFade(showroom);
  });

  it('accepts only finite positive aspects and rebuilds the projection for those', () => {
    const { showroom } = harness();
    const updateProjection = vi.spyOn(showroom.camera, 'updateProjectionMatrix');

    showroom.setAspect(1.5);
    expect(showroom.camera.aspect).toBe(1.5);
    expect(updateProjection).toHaveBeenCalledTimes(1);

    showroom.setAspect(Number.NaN);
    showroom.setAspect(0);
    showroom.setAspect(-2);
    expect(showroom.camera.aspect).toBe(1.5);
    expect(updateProjection).toHaveBeenCalledTimes(1);

    showroom.setAspect(2);
    expect(showroom.camera.aspect).toBe(2);
    expect(updateProjection).toHaveBeenCalledTimes(2);
  });

  it('publishes the turntable yaw and the world yaws of everything it carries', async () => {
    const { showroom } = harness();

    const empty = showroom.turntableState;
    expect(empty.yaw).toBe(0);
    expect(showroom.lookYaw).toBe(0);
    expect(empty.plinthWorldYaw).toBeNull();
    expect(empty.activeLookWorldYaw).toBeNull();
    expect(empty.outgoingLookWorldYaw).toBeNull();
    expect(empty.plinthAttached).toBe(false);
    expect(empty.activeLookAttached).toBe(false);

    await showroom.loadStatics();
    expect(showroom.turntableState.plinthWorldYaw).not.toBeNull();
    await showroom.showLook('first');
    showroom.setLookYaw(Math.PI / 2);
    const turned = showroom.turntableState;
    expect(turned.yaw).toBeCloseTo(Math.PI / 2, 10);
    expect(showroom.lookYaw).toBeCloseTo(Math.PI / 2, 10);
    expect(turned.activeLookWorldYaw).toBeCloseTo(Math.PI / 2, 5);

    await showroom.showLook('second');
    const fading = showroom.turntableState;
    expect(fading.outgoingLookWorldYaw).not.toBeNull();
    expect(fading.outgoingLookAttached).toBe(true);
    expect(fading.activeLookAttached).toBe(true);
    expect(fading.activeLookWorldYaw).toBeCloseTo(Math.PI / 2, 5);

    await finishFade(showroom);
    const settled = showroom.turntableState;
    expect(settled.outgoingLookWorldYaw).toBeNull();
    expect(settled.outgoingLookAttached).toBe(false);
  });
});
