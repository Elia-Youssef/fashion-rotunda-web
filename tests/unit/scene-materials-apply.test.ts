// Unit tests for the tuning applier.

import { Mesh, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial } from 'three/webgpu';
import type { Material } from 'three/webgpu';
import { materialColor } from 'three/tsl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DOME_GLASS_MATERIAL, applyTunings, applyTuning } from '../../src/scene/materials';
import type { MaterialTuning } from '../../src/scene/materials';
import { requireTuning } from '../support/scene-materials';

afterEach(() => {
  vi.restoreAllMocks();
});

interface SerializedNode {
  uuid: string;
  type: string;
  inputNodes?: Record<string, string | string[]>;
  nodes?: SerializedNode[];
  value?: number | number[];
  components?: string;
  method?: string;
  op?: string;
}

// Evaluates the serialized TSL colour graph with plain arithmetic. MaterialNode
// stands for the loader-decoded map sample handed in as `base`; no production
// arithmetic is mocked or replaced.
function evaluateColorGraph(material: MeshStandardMaterial, base: number[]): number[] {
  expect(material.colorNode).toBeDefined();
  const graph = material.colorNode!.toJSON() as unknown as SerializedNode;
  const nodes = new Map([graph, ...(graph.nodes ?? [])].map((node) => [node.uuid, node]));
  function visit(id: string): number[] {
    const node = nodes.get(id)!;
    const input = (name: string) => visit(node.inputNodes![name] as string);
    if (node.type === 'MaterialNode') {
      expect(node.uuid).toBe(materialColor.uuid);
      return base;
    }
    if (node.type === 'ConstNode') return Array.isArray(node.value) ? node.value : [node.value!];
    if (node.type === 'VarNode' || node.type === 'ConvertNode') return input('node');
    if (node.type === 'SplitNode') {
      const values = input('node');
      return [...node.components!].map((c) => values['xyzw'.indexOf(c)]);
    }
    if (node.type === 'JoinNode') return (node.inputNodes!['nodes'] as string[]).flatMap(visit);
    const a = input('aNode');
    const b = input('bNode');
    if (node.method === 'dot') return [a.reduce((sum, v, i) => sum + v * b[i], 0)];
    const length = Math.max(a.length, b.length);
    const channel = (v: number[], i: number) => (v.length === 1 ? v[0] : v[i]);
    return Array.from({ length }, (_, i) => {
      const x = channel(a, i);
      const y = channel(b, i);
      if (node.op === '*') return x * y;
      if (node.op === '-') return x - y;
      if (node.op === '+') return x + y;
      if (node.method === 'max') return Math.max(x, y);
      if (node.method === 'mix') return x + (y - x) * channel(input('cNode'), i);
      throw new Error(`unsupported graph operation ${node.type}/${node.method}/${node.op}`);
    });
  }
  return visit(graph.uuid);
}

/** One physical property alone must be enough to upgrade a standard material. */
const physicalOnlyFields: {
  property: string;
  tuning: MaterialTuning;
  read: (material: MeshPhysicalMaterial) => number;
  expected: number;
}[] = [
  { property: 'transmission', tuning: { transmission: 0.4 }, read: (m) => m.transmission, expected: 0.4 },
  { property: 'thickness', tuning: { thickness: 0.6 }, read: (m) => m.thickness, expected: 0.6 },
  { property: 'ior', tuning: { ior: 1.4 }, read: (m) => m.ior, expected: 1.4 },
  { property: 'clearcoat', tuning: { clearcoat: 0.5 }, read: (m) => m.clearcoat, expected: 0.5 },
  {
    property: 'clearcoatRoughness',
    tuning: { clearcoatRoughness: 0.2 },
    read: (m) => m.clearcoatRoughness,
    expected: 0.2,
  },
  { property: 'anisotropy', tuning: { anisotropy: 0.7 }, read: (m) => m.anisotropy, expected: 0.7 },
  {
    property: 'anisotropyRotation',
    tuning: { anisotropyRotation: 0.35 },
    read: (m) => m.anisotropyRotation,
    expected: 0.35,
  },
  { property: 'sheen', tuning: { sheen: 0.9 }, read: (m) => m.sheen, expected: 0.9 },
  {
    property: 'sheenRoughness',
    tuning: { sheenRoughness: 0.4 },
    read: (m) => m.sheenRoughness,
    expected: 0.4,
  },
  {
    property: 'sheenColor',
    tuning: { sheenColor: [0.2, 0.4, 0.6] },
    read: (m) => m.sheenColor.r,
    expected: 0.2,
  },
];

describe('applyTuning', () => {
  it.each(['MI_Marble_Nero_Base', 'MI_Quartzite_BlueFusion', 'MI_Marble_SilverWave'])(
    '%s applies the chosen 0.5 clearcoat to full and half materials without changing roughness', (name) => {
      expect(requireTuning(name).clearcoat).toBe(0.5);
      for (const material of [
        new MeshPhysicalMaterial({ clearcoat: 1, roughness: 0.42 }),
        new MeshStandardMaterial({ roughness: 0.42 }),
      ]) {
        material.name = name;
        const applied = applyTuning(new Mesh(undefined, material), requireTuning(name)) as MeshPhysicalMaterial;
        expect(applied.clearcoat).toBe(0.5);
        expect(applied.clearcoatRoughness).toBe(0.1);
        expect(applied.roughness).toBe(0.42);
        applied.dispose();
        if (applied !== material) material.dispose();
      }
    },
  );

  it('applies the chosen inlay clearcoat to full and half materials without changing roughness', () => {
    for (const material of [
      new MeshPhysicalMaterial({ clearcoat: 1, roughness: 0.42 }),
      new MeshStandardMaterial({ roughness: 0.42 }),
    ]) {
      material.name = 'MI_Marble_Nero_Vert';
      const applied = applyTuning(new Mesh(undefined, material), requireTuning(material.name));
      const physical = applied as MeshPhysicalMaterial;
      expect(physical.clearcoat).toBe(0.3);
      expect(physical.clearcoatRoughness).toBe(0.1);
      expect(physical.roughness).toBe(0.42);
      physical.dispose();
      if (applied !== material) material.dispose();
    }
  });

  it('upgrades MeshStandardMaterial to MeshPhysicalMaterial when clearcoat is tuned', () => {
    const standard = new MeshStandardMaterial({ roughness: 0.5 });
    standard.name = 'MI_Marble_Nero_Base';
    const mesh = new Mesh(undefined, standard);

    const applied = applyTuning(mesh, requireTuning('MI_Marble_Nero_Base'));
    expect(mesh.material).toBe(applied);
    expect(applied).toBeInstanceOf(MeshPhysicalMaterial);
    const physical = applied as MeshPhysicalMaterial;
    expect(physical.clearcoat).toBe(0.5);
    expect(physical.clearcoatRoughness).toBe(0.1);
  });

  it('preserves existing MeshPhysicalMaterial instance when tuning in place', () => {
    const physical = new MeshPhysicalMaterial({ roughness: 0.2, metalness: 1 });
    physical.name = DOME_GLASS_MATERIAL;
    const mesh = new Mesh(undefined, physical);

    const applied = applyTuning(mesh, requireTuning(DOME_GLASS_MATERIAL));
    expect(applied).toBe(physical);
    expect(mesh.material).toBe(physical);
    expect(physical.transmission).toBe(1.0);
    expect(physical.thickness).toBe(0.02);
    expect(physical.ior).toBe(1.0);
    expect(physical.roughness).toBe(0.05);
    expect(physical.metalness).toBe(0);
    expect(physical.transparent).toBe(false);
    expect(physical.depthWrite).toBe(true);
    expect(physical.opacity).toBe(1.0);
  });

  it('applies anisotropy and rotation on brass', () => {
    const standard = new MeshStandardMaterial({ metalness: 1.0, roughness: 0.3 });
    standard.name = 'MI_Metal_Brass_02';
    const mesh = new Mesh(undefined, standard);

    const applied = applyTuning(mesh, requireTuning('MI_Metal_Brass_02'));
    expect(applied).toBeInstanceOf(MeshPhysicalMaterial);
    const physical = applied as MeshPhysicalMaterial;
    expect(physical.anisotropy).toBe(0.85);
    expect(physical.anisotropyRotation).toBe(0);
  });

  it('applies sheen on woven garment materials', () => {
    const standard = new MeshStandardMaterial();
    standard.name = 'MI_WallisDressA';
    const mesh = new Mesh(undefined, standard);

    const applied = applyTuning(mesh, requireTuning('MI_WallisDressA'));
    expect(applied).toBeInstanceOf(MeshPhysicalMaterial);
    const physical = applied as MeshPhysicalMaterial;
    expect(physical.sheen).toBe(1.0);
    expect(physical.sheenRoughness).toBe(0.6);
    expect(physical.sheenColor.r).toBeCloseTo(0.27, 2);
    expect(physical.sheenColor.g).toBeCloseTo(0.37, 2);
    expect(physical.sheenColor.b).toBeCloseTo(0.63, 2);
  });

  it('rejects a multi-material mesh instead of discarding a material slot', () => {
    const first = new MeshStandardMaterial();
    first.name = 'first';
    const second = new MeshStandardMaterial();
    second.name = 'MI_Marble_Nero_Base';
    const mesh = new Mesh(undefined, [first, second]);

    expect(() => applyTuning(mesh, requireTuning('MI_Marble_Nero_Base'))).toThrow(
      'one material per mesh',
    );
    expect(mesh.material).toEqual([first, second]);
  });

  it('reapplies garment tuning after initial and later variant material assignments', () => {
    const root = new Mesh();
    const first = new MeshStandardMaterial();
    first.name = 'MI_WallisDressA';
    root.material = first;

    applyTunings(root);
    expect(root.material).toBeInstanceOf(MeshPhysicalMaterial);
    if (!(root.material instanceof MeshPhysicalMaterial)) {
      throw new Error('initial variant material did not upgrade');
    }
    expect(root.material.sheen).toBe(1);

    const later = new MeshStandardMaterial();
    later.name = 'MI_WallisDressA';
    root.material = later;

    applyTunings(root);
    expect(root.material).toBeInstanceOf(MeshPhysicalMaterial);
    if (!(root.material instanceof MeshPhysicalMaterial)) {
      throw new Error('later variant material did not upgrade');
    }
    expect(root.material.sheen).toBe(1);
  });

  it('registers both sides of every physical upgrade before replacement', () => {
    const physical = new MeshPhysicalMaterial({ roughness: 0.4 });
    physical.name = 'MI_Marble_Nero_Base';
    const inPlace = new Mesh(undefined, physical);
    const acquiredInPlace: Material[] = [];
    applyTuning(inPlace, requireTuning('MI_Marble_Nero_Base'), (material) =>
      acquiredInPlace.push(material),
    );
    // Tuning a material that is already physical displaces nothing and creates nothing.
    expect(acquiredInPlace).toEqual([]);

    const standard = new MeshStandardMaterial({ roughness: 0.5 });
    standard.name = 'MI_Marble_Nero_Base';
    const mesh = new Mesh(undefined, standard);
    const acquired: Material[] = [];
    const insideCopy: { assigned: unknown; acquired: Material[] }[] = [];
    const realCopy = MeshStandardMaterial.prototype.copy;
    vi.spyOn(MeshStandardMaterial.prototype, 'copy').mockImplementation(function (
      this: MeshStandardMaterial,
      source: Material,
    ) {
      insideCopy.push({ assigned: mesh.material, acquired: [...acquired] });
      return realCopy.call(this, source);
    });

    const applied = applyTuning(mesh, requireTuning('MI_Marble_Nero_Base'), (material) =>
      acquired.push(material),
    );

    expect(mesh.material).toBe(applied);
    // The displaced material first, then the new instance, and nothing else.
    expect(acquired).toEqual([standard, applied]);
    // Inside the copy the handoff has already happened and the mesh still wears the material
    // being displaced: both facts are what a throwing copy would rely on.
    expect(insideCopy).toEqual([{ assigned: standard, acquired: [standard, applied] }]);
  });

  it('owns the new instance when copy throws', () => {
    const standard = new MeshStandardMaterial();
    standard.name = 'MI_Marble_Nero_Base';
    const mesh = new Mesh(undefined, standard);
    const acquired: Material[] = [];
    const failure = new Error('material copy failed');
    vi.spyOn(MeshStandardMaterial.prototype, 'copy').mockImplementation(() => {
      throw failure;
    });

    expect(() =>
      applyTuning(mesh, requireTuning('MI_Marble_Nero_Base'), (material) =>
        acquired.push(material),
      ),
    ).toThrow(failure);

    // The failed upgrade leaves the mesh untouched, and both sides of the handoff are owned:
    // the displacement never happened, and the replacement never reached a mesh.
    expect(mesh.material).toBe(standard);
    expect(acquired[0]).toBe(standard);
    expect(acquired).toHaveLength(2);
    expect(acquired[1]).toBeInstanceOf(MeshPhysicalMaterial);
  });

  it.each(physicalOnlyFields)(
    'upgrades a standard material when $property is the only physical field',
    ({ tuning, read, expected }) => {
      const standard = new MeshStandardMaterial();
      const mesh = new Mesh(undefined, standard);

      const applied = applyTuning(mesh, tuning);

      expect(applied).toBe(mesh.material);
      expect(applied).toBeInstanceOf(MeshPhysicalMaterial);
      expect(read(applied as MeshPhysicalMaterial)).toBe(expected);
      (applied as MeshPhysicalMaterial).dispose();
    },
  );

  it('rejects a material that is not a MeshStandardMaterial', () => {
    const basic = new MeshBasicMaterial();
    basic.name = 'M_Glass_Flat_SM_Dome_A';
    const mesh = new Mesh(undefined, basic);

    expect(() => applyTuning(mesh, { roughness: 0.4 })).toThrow('needs MeshStandardMaterial');
    expect(mesh.material).toBe(basic);
  });

  it('applyTunings rejects a tuned material that sits inside a multi-material mesh', () => {
    const first = new MeshStandardMaterial();
    first.name = 'first';
    const nero = new MeshStandardMaterial();
    nero.name = 'MI_Marble_Nero_Base';
    const mesh = new Mesh(undefined, [first, nero]);

    expect(() => applyTunings(mesh)).toThrow('one material per mesh');
  });

  it('resets blending only for a positive transmission', () => {
    const open = new MeshPhysicalMaterial({ transparent: true, opacity: 0.4, depthWrite: false });
    applyTuning(new Mesh(undefined, open), { transmission: 1 });
    expect(open.transmission).toBe(1);
    expect(open.transparent).toBe(false);
    expect(open.depthWrite).toBe(true);
    expect(open.opacity).toBe(1.0);

    const closed = new MeshPhysicalMaterial({ transparent: true, opacity: 0.4, depthWrite: false });
    applyTuning(new Mesh(undefined, closed), { transmission: 0 });
    expect(closed.transmission).toBe(0);
    expect(closed.transparent).toBe(true);
    expect(closed.depthWrite).toBe(false);
    expect(closed.opacity).toBe(0.4);
  });

  it('applies envMapIntensity', () => {
    const standard = new MeshStandardMaterial();
    expect(standard.envMapIntensity).toBe(1);

    const applied = applyTuning(new Mesh(undefined, standard), { envMapIntensity: 2.5 });

    expect(applied).toBe(standard);
    expect(standard.envMapIntensity).toBe(2.5);
  });

  it('resets a non-default anisotropy rotation on brass', () => {
    const physical = new MeshPhysicalMaterial({
      anisotropy: 1,
      anisotropyRotation: 0.7,
      metalness: 1,
      roughness: 0.3,
    });
    physical.name = 'MI_Metal_Brass_02';

    applyTuning(new Mesh(undefined, physical), requireTuning('MI_Metal_Brass_02'));

    expect(physical.anisotropy).toBe(0.85);
    expect(physical.anisotropyRotation).toBe(0);
  });

  it('marks a tuned material for recompilation', () => {
    const standard = new MeshStandardMaterial();
    const mesh = new Mesh(undefined, standard);
    const before = standard.version;

    applyTuning(mesh, { roughness: 0.6 });

    expect(standard.roughness).toBe(0.6);
    // needsUpdate is a write-only setter; the version counter is its observable.
    expect(standard.version).toBe(before + 1);
  });

  it('clamps the tuned base colour at zero while passing alpha through', () => {
    const material = new MeshStandardMaterial();
    applyTuning(new Mesh(undefined, material), { baseContrast: 1.5 });

    // 1.5 x contrast about 0.18 drives 0.02 below zero; the graph clamps RGB at
    // zero and leaves the map alpha untouched.
    const rgb = evaluateColorGraph(material, [0.02, 0.2, 0.8, 0.42]);
    expect(rgb[0]).toBeCloseTo(0, 8);
    expect(rgb[1]).toBeCloseTo(0.21, 8);
    expect(rgb[2]).toBeCloseTo(1.11, 8);
    expect(rgb[3]).toBe(0.42);
  });
});
