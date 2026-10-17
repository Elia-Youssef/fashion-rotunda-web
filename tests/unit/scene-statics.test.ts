import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three/webgpu';
import type { Material, Object3D } from 'three/webgpu';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';
import type { Catalog } from '../../src/catalog/catalog';
import { loadStatics } from '../../src/scene/statics';

type TuneFn = (root: Object3D, acquire: (material: Material) => void, fileName?: string) => void;
type MountedFn = (statics: { plinthRoot: Object3D; plinthTopY: number }) => void;

const catalog: Catalog = {
  version: 1,
  environment: { file: 'sky.hdr' },
  rotunda: { file: 'rotunda.glb' },
  plinth: { file: 'plinth.glb' },
  looks: [],
  views: { proof: { position: [0, 2, 5], target: [0, 1, 0], fov: 45 } },
};

/**
 * One static with a footprint nothing else in the file shares, so a top measured from the
 * wrong root, or on the wrong axis, cannot pass as the right number: the rotunda is wide
 * and tall, the plinth narrow and short.
 */
function staticFixture(name: string, width: number, height: number) {
  const root = new Group();
  root.name = name;
  const material = new MeshStandardMaterial({ name: `${name}-surface` });
  const geometry = new BoxGeometry(width, height, width);
  // A static stands on the floor, so its centre sits at half its height.
  const mesh = new Mesh(geometry, material);
  mesh.position.y = height / 2;
  root.add(mesh);
  const gltf: GLTF = Object.create(null);
  gltf.scene = root;
  return {
    gltf,
    root,
    mesh,
    material,
    disposeMaterial: vi.spyOn(material, 'dispose'),
    disposeGeometry: vi.spyOn(geometry, 'dispose'),
  };
}

/** One macrotask boundary, so the failure path's release handlers have drained. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function harness() {
  const rotunda = staticFixture('rotunda', 10, 8);
  const plinth = staticFixture('plinth', 1, 3);
  const scene = new Group();
  const turntable = new Group();
  const loadGltf = vi.fn<(url: string, signal: AbortSignal) => Promise<GLTF>>(
    async (url) => (url === '/content/rotunda.glb' ? rotunda.gltf : plinth.gltf),
  );
  const decorate = vi.fn<(root: Object3D) => void>();
  const tune = vi.fn<TuneFn>();
  const mounted = vi.fn<MountedFn>();
  function load(overrides: { tune?: TuneFn; mounted?: MountedFn } = {}): Promise<void> {
    return loadStatics({
      loadGltf,
      catalog,
      contentBase: '/content',
      decorate,
      tune: overrides.tune ?? tune,
      beforeMount: undefined,
      scene,
      turntable,
      mounted: overrides.mounted ?? mounted,
    });
  }
  return { rotunda, plinth, scene, turntable, loadGltf, decorate, tune, mounted, load };
}

describe('loadStatics', () => {
  it('loads each static by its own file, mounts it, and keeps it for the page lifetime', async () => {
    const h = harness();
    await expect(h.load()).resolves.toBeUndefined();

    expect(h.loadGltf.mock.calls.map(([url]) => url).sort()).toEqual([
      '/content/plinth.glb', '/content/rotunda.glb',
    ]);
    expect(h.rotunda.root.parent).toBe(h.scene);
    expect(h.plinth.root.parent).toBe(h.turntable);
    expect(h.decorate.mock.calls.map(([root]) => root)).toEqual([h.rotunda.root, h.plinth.root]);
    expect(h.rotunda.disposeGeometry).not.toHaveBeenCalled();
    expect(h.plinth.disposeGeometry).not.toHaveBeenCalled();
    expect(h.rotunda.disposeMaterial).not.toHaveBeenCalled();
    expect(h.plinth.disposeMaterial).not.toHaveBeenCalled();
  });

  it('publishes the plinth root with the height of its top surface', async () => {
    const h = harness();
    await h.load();

    expect(h.mounted).toHaveBeenCalledTimes(1);
    const published = h.mounted.mock.calls[0][0];
    expect(published.plinthRoot).toBe(h.plinth.root);
    // Three metres up on the plinth, which neither the rotunda's top nor any horizontal
    // extent of either static equals.
    expect(published.plinthTopY).toBe(3);
  });

  it('hands each static to tune with its own catalogue file name', async () => {
    const h = harness();
    await h.load();

    const calls = h.tune.mock.calls;
    expect(calls).toHaveLength(2);
    const tuned = new Set<Object3D>();
    for (const [root, acquire, fileName] of calls) {
      tuned.add(root);
      expect(fileName).toBe(root === h.rotunda.root ? catalog.rotunda.file : catalog.plinth.file);
      expect(acquire).toBeInstanceOf(Function);
    }
    expect(tuned).toEqual(new Set([h.rotunda.root, h.plinth.root]));
  });

  it('starts both loads on a live signal, so neither route is dead on arrival', async () => {
    const h = harness();
    await h.load();

    expect(h.loadGltf).toHaveBeenCalledTimes(2);
    for (const [, signal] of h.loadGltf.mock.calls) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
    }
  });

  it('releases what a tune replaced on the meshes even when the tune keeps no handoff', async () => {
    const h = harness();
    // A tune that swaps a mesh's material without telling the acquire callback is within
    // the option's type. The release path owns the root as it is by then, not only the
    // parse-time snapshot, so both the displaced original and the swap-in are freed.
    const swapIn = new MeshStandardMaterial({ name: 'tuning-swap-in' });
    const swapInDispose = vi.spyOn(swapIn, 'dispose');
    const failure = new Error('the plinth tuning failed');
    const failing = expect(h.load({
      tune: (root): void => {
        if (root === h.rotunda.root) {
          h.rotunda.mesh.material = swapIn;
          return;
        }
        throw failure;
      },
    })).rejects.toBe(failure);
    await failing;
    await flush();

    expect(h.rotunda.disposeMaterial).toHaveBeenCalledTimes(1);
    expect(swapInDispose).toHaveBeenCalledTimes(1);
    expect(h.plinth.disposeMaterial).toHaveBeenCalledTimes(1);
    expect(h.rotunda.disposeGeometry).toHaveBeenCalledTimes(1);
    expect(h.plinth.disposeGeometry).toHaveBeenCalledTimes(1);
    expect(h.rotunda.root.parent).toBeNull();
    expect(h.plinth.root.parent).toBeNull();
  });

  it('treats a failure thrown by mounted as the pair\'s own', async () => {
    const h = harness();
    const failure = new Error('placement failed');
    const failing = expect(h.load({ mounted: (): void => { throw failure; } })).rejects.toBe(failure);
    await failing;
    await flush();

    expect(h.rotunda.disposeGeometry).toHaveBeenCalledTimes(1);
    expect(h.plinth.disposeGeometry).toHaveBeenCalledTimes(1);
    expect(h.rotunda.disposeMaterial).toHaveBeenCalledTimes(1);
    expect(h.plinth.disposeMaterial).toHaveBeenCalledTimes(1);
  });
});
