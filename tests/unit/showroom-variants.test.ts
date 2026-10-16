import { Mesh, MeshPhysicalMaterial, MeshStandardMaterial } from 'three/webgpu';
import type { Material } from 'three/webgpu';
import type { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createShowroomHarness, deferred, finishFade } from '../support/showroom';

// The mannequin swatch machinery: a variant applied mid-switch, swatches that resolve after
// their look retired or mid-fade, and ownership of finalized clones and partial swaps.

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

  it('retires replacements after a partially failing live tune', async () => {
    const { showroom, first } = harness();
    await showroom.showLook('first');
    // A live swatch puts one tuned material on two meshes; the first mesh's upgrade lands,
    // the second mesh's copy throws, so the traversal fails after a replacement exists.
    first.materials[1].name = 'MI_Marble_Nero_Base';
    const extra = new Mesh(first.geometry, first.materials[0]);
    extra.userData['gltfExtensions'] = {
      KHR_materials_variants: { mappings: [{ material: 1, variants: [1] }] },
    };
    first.root.add(extra);
    const failure = new Error('material copy failed');
    const upgradeDisposals: number[] = [];
    const realCopy = MeshStandardMaterial.prototype.copy;
    vi.spyOn(MeshStandardMaterial.prototype, 'copy').mockImplementation(function (
      this: MeshStandardMaterial,
      source: Material,
    ) {
      const index = upgradeDisposals.length;
      upgradeDisposals.push(0);
      const realDispose = this.dispose.bind(this);
      this.dispose = (): void => {
        upgradeDisposals[index] += 1;
        realDispose();
      };
      if (index === 1) {
        throw failure;
      }
      return realCopy.call(this, source);
    });

    await expect(showroom.setVariant('light')).rejects.toThrow(failure);
    // The traversal stopped after the first replacement: the mannequin wears it, the second
    // mesh keeps the resolved variant material, and no variant state moved.
    expect(first.mannequin.material).toBeInstanceOf(MeshPhysicalMaterial);
    expect(extra.material).toBe(first.materials[1]);
    expect(showroom.currentVariant).toBe('base');

    await showroom.showLook('second');
    await finishFade(showroom);

    // Both replacements, the one on the mesh and the one the throwing copy orphaned, are
    // retired with the look, once each.
    expect(upgradeDisposals).toEqual([1, 1]);
    expect(first.disposal.materials[1]).toHaveBeenCalledTimes(1);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);
  });
});
