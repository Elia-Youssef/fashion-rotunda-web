import { BufferGeometry, Group, Material, Mesh, MeshStandardMaterial } from 'three/webgpu';
import type { GLTF, GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { listVariants, selectVariant } from '../../src/scene/variants';

// The tree is built from real three.js objects, because selectVariant identifies meshes and
// materials with instanceof and a plain object would never match. The parser is the part that is
// faked: a real GLTFParser needs a parsed file, and the helper only calls two of its methods.

interface FakeParser {
  parser: GLTFParser;
  /** Every getDependency call, in order, as type and index. */
  calls: [string, number][];
  /** The meshes handed to assignFinalMaterial, in order. */
  finalised: Mesh[];
}

function fakeParser(materials: Material[]): FakeParser {
  const calls: [string, number][] = [];
  const finalised: Mesh[] = [];
  // GLTFParser has two dozen members and no runtime export (GLTFLoader.js exports GLTFLoader
  // alone, line 4925), so the stand-in is built from an empty object. Object.create is what makes
  // this compile without a type assertion; the two methods below are all selectVariant touches.
  const parser: GLTFParser = Object.create(null);
  parser.getDependency = (type: string, index: number): Promise<Material> => {
    calls.push([type, index]);
    const material = materials[index];
    if (material === undefined) {
      return Promise.reject(new Error(`no material ${index}`));
    }
    return Promise.resolve(material);
  };
  parser.assignFinalMaterial = (mesh: Mesh): void => {
    finalised.push(mesh);
  };
  return { parser, calls, finalised };
}

function gltfWithVariants(names: string[]): GLTF {
  const gltf: GLTF = Object.create(null);
  gltf.userData = {
    gltfExtensions: { KHR_materials_variants: { variants: names.map((name) => ({ name })) } },
  };
  return gltf;
}

function mannequin(material: Material, mappings: unknown): Mesh {
  const mesh = new Mesh(new BufferGeometry(), material);
  mesh.name = 'mannequin-mesh';
  mesh.userData['gltfExtensions'] = { KHR_materials_variants: { mappings } };
  return mesh;
}

function garment(material: Material): Mesh {
  const mesh = new Mesh(new BufferGeometry(), material);
  mesh.name = 'garment-mesh';
  return mesh;
}

/** The three swatch materials in the file's own order: base, light, dark. */
function swatches(): MeshStandardMaterial[] {
  return [
    new MeshStandardMaterial({ name: 'MI_Mannequin_Base' }),
    new MeshStandardMaterial({ name: 'MI_Mannequin_Light' }),
    new MeshStandardMaterial({ name: 'MI_Mannequin_Dark' }),
  ];
}

describe('listVariants', () => {
  it('returns the names in file order, which is the index space the mappings use', () => {
    expect(listVariants(gltfWithVariants(['base', 'light', 'dark']))).toEqual([
      'base',
      'light',
      'dark',
    ]);
  });

  it('returns nothing for a file that carries no variants', () => {
    const gltf: GLTF = Object.create(null);
    gltf.userData = {};
    expect(listVariants(gltf)).toEqual([]);
  });

  it('skips entries that are not named, instead of reporting a nameless variant', () => {
    const gltf: GLTF = Object.create(null);
    gltf.userData = {
      gltfExtensions: { KHR_materials_variants: { variants: [{ name: 'base' }, {}, 7] } },
    };
    expect(listVariants(gltf)).toEqual(['base']);
  });

  it('returns nothing when the extension block or its fields are malformed', () => {
    const malformed: unknown[] = [
      null,
      'nope',
      {},
      { KHR_materials_variants: null },
      { KHR_materials_variants: {} },
      { KHR_materials_variants: { variants: 42 } },
    ];
    for (const gltfExtensions of malformed) {
      const gltf: GLTF = Object.create(null);
      gltf.userData = { gltfExtensions };
      expect(listVariants(gltf)).toEqual([]);
    }
  });

  it('skips null entries and empty names', () => {
    const gltf: GLTF = Object.create(null);
    gltf.userData = {
      gltfExtensions: {
        KHR_materials_variants: { variants: [{ name: 'base' }, null, { name: '' }] },
      },
    };
    expect(listVariants(gltf)).toEqual(['base']);
  });
});

describe('selectVariant', () => {
  it('puts the mapped material on the mapped mesh and lets the parser finish it', async () => {
    const materials = swatches();
    const { parser, calls, finalised } = fakeParser(materials);
    const mesh = mannequin(materials[0], [
      { material: 0, variants: [0] },
      { material: 1, variants: [1] },
      { material: 2, variants: [2] },
    ]);
    const root = new Group();
    root.add(mesh);

    await selectVariant({ root, parser, variants: ['base', 'light', 'dark'] }, 'dark');

    expect(mesh.material).toBe(materials[2]);
    expect(calls).toEqual([['material', 2]]);
    expect(finalised).toEqual([mesh]);
  });

  it('leaves a mesh that carries no mapping alone', async () => {
    const materials = swatches();
    const dress = new MeshStandardMaterial({ name: 'MI_Wallis' });
    const { parser, finalised } = fakeParser(materials);
    const mesh = mannequin(materials[0], [{ material: 1, variants: [1] }]);
    const other = garment(dress);
    const root = new Group();
    root.add(mesh, other);

    await selectVariant({ root, parser, variants: ['base', 'light', 'dark'] }, 'light');

    expect(other.material).toBe(dress);
    expect(finalised).toEqual([mesh]);
  });

  it('restores the primitive first material when the variant has no mapping for it', async () => {
    const materials = swatches();
    const { parser } = fakeParser(materials);
    const mesh = mannequin(materials[0], [{ material: 2, variants: [2] }]);
    const root = new Group();
    root.add(mesh);
    const variants = ['base', 'light', 'dark'];

    await selectVariant({ root, parser, variants }, 'dark');
    expect(mesh.material).toBe(materials[2]);

    await selectVariant({ root, parser, variants }, 'base');
    expect(mesh.material).toBe(materials[0]);
  });

  it('remembers the first material once, not whichever variant was on last', async () => {
    const materials = swatches();
    const { parser } = fakeParser(materials);
    const mesh = mannequin(materials[0], [
      { material: 1, variants: [1] },
      { material: 2, variants: [2] },
    ]);
    const root = new Group();
    root.add(mesh);
    const variants = ['base', 'light', 'dark'];

    await selectVariant({ root, parser, variants }, 'light');
    await selectVariant({ root, parser, variants }, 'dark');
    await selectVariant({ root, parser, variants }, 'base');

    expect(mesh.material).toBe(materials[0]);
  });

  it('throws on a variant the file does not have', async () => {
    const materials = swatches();
    const { parser } = fakeParser(materials);
    const root = new Group();
    root.add(mannequin(materials[0], [{ material: 0, variants: [0] }]));

    await expect(
      selectVariant({ root, parser, variants: ['base', 'light', 'dark'] }, 'chrome'),
    ).rejects.toThrow('chrome');
  });

  it('ignores a mapping block that is not the shape the extension defines', async () => {
    const materials = swatches();
    const { parser, calls } = fakeParser(materials);
    const mesh = mannequin(materials[0], [{ material: 'two', variants: [2] }, 'nonsense']);
    const root = new Group();
    root.add(mesh);

    await selectVariant({ root, parser, variants: ['base', 'light', 'dark'] }, 'dark');

    expect(mesh.material).toBe(materials[0]);
    expect(calls).toEqual([]);
  });

  it('throws when a mapped mesh carries a material array, which no glTF primitive does', async () => {
    const materials = swatches();
    const { parser } = fakeParser(materials);
    const mesh = new Mesh(new BufferGeometry(), [materials[0], materials[1]]);
    mesh.name = 'mannequin-mesh';
    mesh.userData['gltfExtensions'] = {
      KHR_materials_variants: { mappings: [{ material: 2, variants: [2] }] },
    };
    const root = new Group();
    root.add(mesh);

    await expect(
      selectVariant({ root, parser, variants: ['base', 'light', 'dark'] }, 'dark'),
    ).rejects.toThrow('material array');
  });

  it('registers each resolved material with acquire before it reaches the mesh', async () => {
    const materials = swatches();
    const { parser } = fakeParser(materials);
    // What the mesh carried at acquire time: 'prior' proves the registration happens before the
    // commit, not only before the end of the swap.
    const observed: string[] = [];
    const mesh = mannequin(materials[0], [{ material: 2, variants: [2] }]);
    const root = new Group();
    root.add(mesh);

    await selectVariant({
      root,
      parser,
      variants: ['base', 'light', 'dark'],
      acquire: (material: Material): void => {
        observed.push(mesh.material === material ? 'committed' : 'prior');
      },
    }, 'dark');

    expect(observed).toEqual(['prior']);
    expect(mesh.material).toBe(materials[2]);
  });

  it('stops before the next commit when the owning look retires mid-swap', async () => {
    const materials = swatches();
    const first = mannequin(materials[0], [{ material: 1, variants: [2] }]);
    const second = mannequin(materials[0], [{ material: 2, variants: [2] }]);
    const root = new Group();
    root.add(first, second);
    const acquired: Material[] = [];
    const finalised: Mesh[] = [];
    let retired = false;
    let resolutions = 0;
    let releaseHeld!: (material: Material) => void;
    const held = new Promise<Material>((resolve) => {
      releaseHeld = resolve;
    });
    // The first resolution commits normally; the second stays pending so the test can retire
    // the look while the swap is mid-flight.
    const parser: GLTFParser = Object.create(null);
    parser.getDependency = (_type: string, index: number): Promise<Material> => {
      resolutions += 1;
      return resolutions === 1 ? Promise.resolve(materials[index]) : held;
    };
    parser.assignFinalMaterial = (mesh: Mesh): void => {
      finalised.push(mesh);
    };

    const swap = selectVariant({
      root,
      parser,
      variants: ['base', 'light', 'dark'],
      acquire: (material: Material): void => {
        acquired.push(material);
      },
      superseded: (): boolean => retired,
    }, 'dark');
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(first.material).toBe(materials[1]);

    retired = true;
    releaseHeld(materials[2]);
    await swap;

    // The material resolved after retirement is registered (its owner releases it), but no
    // mesh beyond the retirement is touched.
    expect(acquired).toEqual([materials[1], materials[2]]);
    expect(second.material).toBe(materials[0]);
    expect(finalised).toEqual([first]);
  });

  it('leaves meshes whose mapping block is absent or malformed alone', async () => {
    const materials = swatches();
    const { parser, calls, finalised } = fakeParser(materials);
    const mapped = mannequin(materials[0], [{ material: 1, variants: [2] }]);
    const noExtensions = garment(materials[1]);
    noExtensions.userData = { gltfExtensions: {} };
    const noVariantBlock = garment(materials[1]);
    noVariantBlock.userData = { gltfExtensions: { KHR_materials_variants: {} } };
    const notArray = garment(materials[1]);
    notArray.userData = { gltfExtensions: { KHR_materials_variants: { mappings: 42 } } };
    const root = new Group();
    root.add(mapped, noExtensions, noVariantBlock, notArray);

    await selectVariant({ root, parser, variants: ['base', 'light', 'dark'] }, 'dark');

    expect(mapped.material).toBe(materials[1]);
    expect(noExtensions.material).toBe(materials[1]);
    expect(noVariantBlock.material).toBe(materials[1]);
    expect(notArray.material).toBe(materials[1]);
    expect(calls).toEqual([['material', 1]]);
    expect(finalised).toEqual([mapped]);
  });

  it('ignores a null mapping entry and keeps the mapping after it', async () => {
    const materials = swatches();
    const { parser, calls } = fakeParser(materials);
    const mesh = mannequin(materials[0], [null, { material: 1, variants: [2] }]);
    const root = new Group();
    root.add(mesh);

    await selectVariant({ root, parser, variants: ['base', 'light', 'dark'] }, 'dark');

    expect(mesh.material).toBe(materials[1]);
    expect(calls).toEqual([['material', 1]]);
  });

  it('ignores a mapping whose variants is not an array, however it iterates', async () => {
    const materials = swatches();
    const { parser, calls } = fakeParser(materials);
    // A Set of the right index must not read as a mapping: only the extension's
    // own shape (an array of integers) selects a material.
    const mesh = mannequin(materials[0], [{ material: 1, variants: new Set([2]) }]);
    const root = new Group();
    root.add(mesh);

    await selectVariant({ root, parser, variants: ['base', 'light', 'dark'] }, 'dark');

    expect(mesh.material).toBe(materials[0]);
    expect(calls).toEqual([]);
  });

  it('never touches a non-mesh object that carries mapping-like data', async () => {
    const materials = swatches();
    const { parser, calls, finalised } = fakeParser(materials);
    const bystander = new Group();
    bystander.name = 'bystander';
    bystander.userData = {
      gltfExtensions: { KHR_materials_variants: { mappings: [{ material: 1, variants: [2] }] } },
    };
    const mesh = mannequin(materials[0], [{ material: 2, variants: [2] }]);
    const root = new Group();
    root.add(bystander, mesh);

    await selectVariant({ root, parser, variants: ['base', 'light', 'dark'] }, 'dark');

    expect(mesh.material).toBe(materials[2]);
    expect(calls).toEqual([['material', 2]]);
    expect(finalised).toEqual([mesh]);
    expect('material' in bystander).toBe(false);
  });

  it('leaves a mapping-less mesh that carries a material array alone', async () => {
    const materials = swatches();
    const { parser, calls } = fakeParser(materials);
    const arrayMesh = new Mesh(new BufferGeometry(), [materials[0], materials[1]]);
    arrayMesh.name = 'array-mesh';
    const mesh = mannequin(materials[0], [{ material: 2, variants: [2] }]);
    const root = new Group();
    root.add(arrayMesh, mesh);

    await selectVariant({ root, parser, variants: ['base', 'light', 'dark'] }, 'dark');

    expect(mesh.material).toBe(materials[2]);
    expect(arrayMesh.material).toEqual([materials[0], materials[1]]);
    expect(calls).toEqual([['material', 2]]);
  });

  it('ignores a parked original that is not a material', async () => {
    const materials = swatches();
    const { parser } = fakeParser(materials);
    const mesh = mannequin(materials[0], [{ material: 2, variants: [2] }]);
    mesh.userData['originalMaterial'] = 42;
    const root = new Group();
    root.add(mesh);
    const target = { root, parser, variants: ['base', 'light', 'dark'] };

    await selectVariant(target, 'dark');
    expect(mesh.material).toBe(materials[2]);

    // No mapping covers 'base'; a parked value that is not a material must not
    // land on the mesh.
    await selectVariant(target, 'base');
    expect(mesh.material).toBe(materials[2]);
  });

  it('rejects a mapping whose material does not resolve to a material', async () => {
    const materials = swatches();
    const parser: GLTFParser = Object.create(null);
    parser.getDependency = (): Promise<Material> =>
      Promise.resolve({ not: 'a material' } as unknown as Material);
    parser.assignFinalMaterial = (): void => {};
    const mesh = mannequin(materials[0], [{ material: 0, variants: [2] }]);
    const root = new Group();
    root.add(mesh);

    await expect(
      selectVariant({ root, parser, variants: ['base', 'light', 'dark'] }, 'dark'),
    ).rejects.toThrow('did not resolve');
  });

  it('registers the finalized instance a mesh ends up carrying', async () => {
    const materials = swatches();
    const clone = new MeshStandardMaterial({ name: 'MI_Mannequin_Dark_Final' });
    const parser: GLTFParser = Object.create(null);
    parser.getDependency = (_type: string, index: number): Promise<Material> =>
      Promise.resolve(materials[index]);
    parser.assignFinalMaterial = (mesh: Mesh): void => {
      mesh.material = clone;
    };
    const mesh = mannequin(materials[0], [{ material: 2, variants: [2] }]);
    const root = new Group();
    root.add(mesh);
    const acquired: Material[] = [];

    await selectVariant(
      { root, parser, variants: ['base', 'light', 'dark'], acquire: (m) => acquired.push(m) },
      'dark',
    );

    expect(acquired).toEqual([materials[2], clone]);
  });

  it('does not register a finalized value that is not a material', async () => {
    const materials = swatches();
    const parser: GLTFParser = Object.create(null);
    parser.getDependency = (_type: string, index: number): Promise<Material> =>
      Promise.resolve(materials[index]);
    parser.assignFinalMaterial = (mesh: Mesh): void => {
      mesh.material = 42 as unknown as Material;
    };
    const mesh = mannequin(materials[0], [{ material: 2, variants: [2] }]);
    const root = new Group();
    root.add(mesh);
    const acquired: Material[] = [];

    await selectVariant(
      { root, parser, variants: ['base', 'light', 'dark'], acquire: (m) => acquired.push(m) },
      'dark',
    );

    expect(acquired).toEqual([materials[2]]);
  });

  it('registers the finalized material and still rejects when finalization throws', async () => {
    const materials = swatches();
    const clone = new MeshStandardMaterial();
    const failure = new Error('finalization failed');
    const parser: GLTFParser = Object.create(null);
    parser.getDependency = (_type: string, index: number): Promise<Material> =>
      Promise.resolve(materials[index]);
    parser.assignFinalMaterial = (mesh: Mesh): void => {
      mesh.material = clone;
      throw failure;
    };
    const mesh = mannequin(materials[0], [{ material: 2, variants: [2] }]);
    const root = new Group();
    root.add(mesh);
    const acquired: Material[] = [];

    await expect(
      selectVariant(
        { root, parser, variants: ['base', 'light', 'dark'], acquire: (m) => acquired.push(m) },
        'dark',
      ),
    ).rejects.toThrow(failure);
    expect(acquired).toEqual([materials[2], clone]);
  });
});
