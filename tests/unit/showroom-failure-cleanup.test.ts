import { MeshPhysicalMaterial, MeshStandardMaterial } from 'three/webgpu';
import type { Material } from 'three/webgpu';
import type { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShowroomOptions } from '../../src/scene/showroom';
import { createShowroomHarness } from '../support/showroom';

// Release on failure: when a static, a look or a swatch fails partway through loading or
// tuning, every geometry, material and texture it had acquired is disposed exactly once.

const { createGltfLoader, parseAsync } = vi.hoisted(() => ({
  createGltfLoader: vi.fn<() => Promise<GLTFLoader>>(),
  parseAsync: vi.fn<(bytes: ArrayBuffer | string, path: string) => Promise<GLTF>>(),
}));

vi.mock('../../src/scene/loaders', () => ({ createGltfLoader }));

const harness = createShowroomHarness(parseAsync);

/**
 * One macrotask boundary: every microtask chain the tests start (parser resolutions, ownership
 * handoffs) has drained by the time it resolves, without depending on how many hops each has.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
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

  it('retires upgraded statics after a later tuning failure', async () => {
    const { showroom, rotunda, plinth } = harness();
    // The rotunda's tuned mesh upgrades cleanly; the plinth's tuned material is upgraded by a
    // copy that throws, so its replacement is constructed and owned but never reaches its
    // mesh. The failure is one tuning step after the rotunda's upgrades already exist.
    const rotundaOriginal = rotunda.mannequin.material as MeshStandardMaterial;
    const plinthOriginal = plinth.mannequin.material as MeshStandardMaterial;
    rotundaOriginal.name = 'MI_Metal_Brass_02';
    plinthOriginal.name = 'MI_Metal_Brass_02';
    const failure = new Error('material copy failed');
    const upgradeDisposals: number[] = [];
    const realCopy = MeshStandardMaterial.prototype.copy;
    vi.spyOn(MeshStandardMaterial.prototype, 'copy').mockImplementation(function (
      this: MeshStandardMaterial,
      source: Material,
    ) {
      // The constructed replacement exists only here, before it is copied or assigned, so
      // its own disposal is counted from the same moment ownership of it begins.
      const index = upgradeDisposals.length;
      upgradeDisposals.push(0);
      const realDispose = this.dispose.bind(this);
      this.dispose = (): void => {
        upgradeDisposals[index] += 1;
        realDispose();
      };
      if (source === plinthOriginal) {
        throw failure;
      }
      return realCopy.call(this, source);
    });

    await expect(showroom.loadStatics()).rejects.toThrow(failure);
    await flush();

    // The rotunda's on-mesh upgrade is released once with its parse, and the plinth's
    // constructed-but-never-assigned replacement with it, not orphaned by the throw.
    expect(upgradeDisposals).toEqual([1, 1]);
    expect(rotunda.disposal.original).toHaveBeenCalledTimes(1);
    expect(plinth.disposal.original).toHaveBeenCalledTimes(1);
    expect(rotunda.disposal.geometry).toHaveBeenCalledTimes(1);
    expect(plinth.disposal.geometry).toHaveBeenCalledTimes(1);
    expect(rotunda.disposal.texture).toHaveBeenCalledTimes(1);
    expect(plinth.disposal.texture).toHaveBeenCalledTimes(1);
    expect(showroom.turntableState.plinthAttached).toBe(false);
  });

  it('retires a static replacement whose own copy throws before assignment', async () => {
    const { showroom, rotunda, plinth } = harness();
    // The rotunda's tuned material is upgraded by a copy that throws, so its replacement is
    // constructed and owned but never reaches its mesh: the failure path's recollection can
    // only see what a mesh wears, so the rotunda's handoff is the replacement's one owner.
    const rotundaOriginal = rotunda.mannequin.material as MeshStandardMaterial;
    rotundaOriginal.name = 'MI_Metal_Brass_02';
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
      if (source === rotundaOriginal) {
        throw failure;
      }
      return realCopy.call(this, source);
    });

    await expect(showroom.loadStatics()).rejects.toThrow(failure);
    await flush();

    // The constructed replacement retires once with the failed pair, and the plinth that
    // parsed, untuned, is released with it rather than left on the heap.
    expect(upgradeDisposals).toEqual([1]);
    expect(rotunda.disposal.original).toHaveBeenCalledTimes(1);
    expect(rotunda.disposal.geometry).toHaveBeenCalledTimes(1);
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

  it('retires the initial variant retune replacement when its copy throws on load', async () => {
    // The look's default swatch is the variant whose dependency carries a tuned name, so the
    // retune after the initial swap, not the pre-swap tuning, is what upgrades it: its copy
    // throws, leaving the replacement constructed and owned but never assigned.
    const { showroom, first, onChange } = harness(undefined, 'light');
    first.materials[1].name = 'MI_Marble_Nero_Base';
    const failure = new Error('material copy failed');
    const upgradeDisposals: number[] = [];
    vi.spyOn(MeshStandardMaterial.prototype, 'copy').mockImplementation(function (
      this: MeshStandardMaterial,
    ) {
      const index = upgradeDisposals.length;
      upgradeDisposals.push(0);
      const realDispose = this.dispose.bind(this);
      this.dispose = (): void => {
        upgradeDisposals[index] += 1;
        realDispose();
      };
      throw failure;
    });

    await expect(showroom.showLook('first')).rejects.toThrow(failure);

    // The constructed replacement never reached a mesh, so no recollection can recover it:
    // only the retune's handoff owns it, and the rejected load retires it once, with every
    // material the swap resolved and everything the parse created.
    expect(upgradeDisposals).toEqual([1]);
    expect(first.disposal.materials[1]).toHaveBeenCalledTimes(1);
    expect(first.disposal.materials[0]).toHaveBeenCalledTimes(1);
    expect(first.disposal.original).toHaveBeenCalledTimes(1);
    expect(first.disposal.geometry).toHaveBeenCalledTimes(1);
    expect(first.disposal.texture).toHaveBeenCalledTimes(1);
    expect(showroom.currentLook).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
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
