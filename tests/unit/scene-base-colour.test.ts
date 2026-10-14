import { Group, Mesh, MeshStandardMaterial, Texture, DoubleSide } from 'three/webgpu';
import { materialColor, uniform } from 'three/tsl';
import StandardNodeLibrary from 'three/src/renderers/webgpu/nodes/StandardNodeLibrary.js';
import { describe, expect, it } from 'vitest';
import { applyTuning, applyTunings, tuningFor } from '../../src/scene/materials';
import type { MaterialTuning } from '../../src/scene/materials';
import { selectVariant } from '../../src/scene/variants';
import type { VariantTarget } from '../../src/scene/variants';

type ColourMaterial = MeshStandardMaterial;

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

// Evaluate the actual serialized TSL graph. MaterialNode stands for the loader's decoded
// texture times factor; no production arithmetic is mocked or replaced by test arithmetic.
function evaluate(material: ColourMaterial, base: number[]): number[] {
  expect(material.colorNode).toBeDefined();
  const graph = material.colorNode!.toJSON() as unknown as SerializedNode;
  const nodes = new Map([graph, ...(graph.nodes ?? [])].map(node => [node.uuid, node]));
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
      return [...node.components!].map(c => values['xyzw'.indexOf(c)]);
    }
    if (node.type === 'JoinNode') return (node.inputNodes!['nodes'] as string[]).flatMap(visit);
    const a = input('aNode'), b = input('bNode');
    if (node.method === 'dot') return [a.reduce((sum, v, i) => sum + v * b[i], 0)];
    const length = Math.max(a.length, b.length);
    const channel = (v: number[], i: number) => v.length === 1 ? v[0] : v[i];
    return Array.from({ length }, (_, i) => {
      const x = channel(a, i), y = channel(b, i);
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

function tune(tuning: MaterialTuning): ColourMaterial {
  const material: ColourMaterial = new MeshStandardMaterial();
  expect(applyTuning(new Mesh(undefined, material), tuning)).toBe(material);
  return material;
}

describe('base colour tuning', () => {
  it('only adjusted materials acquire a colour graph, including through renderer conversion', () => {
    const root = new Group();
    const names = ['M_BlueSilk', 'Material73835', 'M_CLay', 'MI_Marble_Nero_Base'];
    const meshes = names.map(name => {
      const material: ColourMaterial = new MeshStandardMaterial();
      material.name = name;
      const mesh = new Mesh(undefined, material);
      root.add(mesh);
      return mesh;
    });
    applyTunings(root);
    const library = new StandardNodeLibrary();
    for (let i = 0; i < meshes.length; i++) {
      const material = meshes[i].material as ColourMaterial;
      const converted = library.fromMaterial(material)!;
      if (names[i] === 'M_BlueSilk') {
        expect(material.colorNode).toBeDefined();
        expect(converted.colorNode).toBe(material.colorNode);
      } else {
        expect(material.colorNode).toBeUndefined();
        expect(converted.colorNode).toBeNull();
      }
    }
  });

  it('M_BlueSilk graph reduces chroma, flattens contrast about middle grey and lifts luminance', () => {
    const tuning = tuningFor('M_BlueSilk');
    expect(tuning).not.toBeNull();
    expect(tuning!.baseContrast).toBe(0.9);
    const material = tune(tuning!);
    const source = [0.0163509664, 0.0160118094, 0.0855459063, 0.37];
    const rgb = evaluate(material, source);
    const luma = (v: number[]) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    const chroma = (v: number[]) => Math.max(...v.slice(0, 3)) - Math.min(...v.slice(0, 3));
    // Saturation keeps luminance and scales chroma by 0.8; contrast 0.9 about 0.18 maps each channel to
    // 0.9 x + 0.018; brightness scales everything by 1.1.
    expect(chroma(rgb) / chroma(source)).toBeCloseTo(0.8 * 0.9 * 1.1, 8);
    expect(luma(rgb)).toBeCloseTo(1.1 * (0.9 * luma(source) + 0.1 * 0.18), 8);
    expect(rgb[3]).toBe(source[3]);
  });

  it.each([
    [{ baseSaturation: 0 }, [0.205052, 0.205052, 0.205052, 0.42]],
    [{ baseBrightness: 1.2 }, [0.024, 0.24, 0.96, 0.42]],
    [{ baseContrast: 0.9 }, [0.036, 0.198, 0.738, 0.42]],
  ] satisfies [MaterialTuning, number[]][])(
    'each optional field affects RGB independently: %j', (tuning, expected) => {
      const result = evaluate(tune(tuning), [0.02, 0.2, 0.8, 0.42]);
      result.forEach((v, i) => expect(v).toBeCloseTo(expected[i], 8));
    },
  );

  it('keeps MASK alpha, map, sidedness and fade nodes while tuning and retuning', () => {
    const material: ColourMaterial = new MeshStandardMaterial({
      map: new Texture(), alphaTest: 0.5, side: DoubleSide, opacity: 0.75,
    });
    material.opacityNode = uniform(0.4);
    material.alphaTestNode = uniform(0.5);
    const map = material.map, opacity = material.opacityNode, threshold = material.alphaTestNode;
    const mesh = new Mesh(undefined, material);
    for (let pass = 0; pass < 2; pass++) {
      expect(applyTuning(mesh, { baseBrightness: 1.1 })).toBe(material);
      evaluate(material, [0.2, 0.3, 0.4, 0.12]).forEach((v, i) =>
        expect(v).toBeCloseTo([0.22, 0.33, 0.44, 0.12][i], 8),
      );
      expect(material.map).toBe(map);
      expect(material.opacityNode).toBe(opacity);
      expect(material.alphaTestNode).toBe(threshold);
      expect(material.alphaTest).toBe(0.5);
      expect(material.opacity).toBe(0.75);
      expect(material.side).toBe(DoubleSide);
    }
  });

  it('variant selection and reapplication retain the same tuned dress and untouched swatches', async () => {
    const root = new Group();
    const dress: ColourMaterial = new MeshStandardMaterial();
    dress.name = 'M_BlueSilk';
    const dressMesh = new Mesh(undefined, dress);
    const mannequin = new Mesh(undefined, new MeshStandardMaterial());
    const light: ColourMaterial = new MeshStandardMaterial();
    mannequin.userData = { gltfExtensions: { KHR_materials_variants: {
      mappings: [{ material: 1, variants: [0] }],
    } } };
    root.add(dressMesh, mannequin);
    const target = { root, variants: ['light', 'base'], parser: {
      getDependency: async () => light,
      assignFinalMaterial: () => {},
    } } as unknown as VariantTarget;
    for (const variant of ['light', 'base', 'light']) {
      await selectVariant(target, variant);
      applyTunings(root);
      expect(dressMesh.material).toBe(dress);
      expect(evaluate(dress, [0.2, 0.3, 0.4, 0.6])[3]).toBe(0.6);
      expect((mannequin.material as ColourMaterial).colorNode).toBeUndefined();
    }
  });
});
