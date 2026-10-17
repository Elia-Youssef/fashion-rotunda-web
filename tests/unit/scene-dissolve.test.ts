import { Group, Mesh, MeshStandardMaterial } from 'three/webgpu';
import type { Material } from 'three/webgpu';
import { screenCoordinate, uniform } from 'three/tsl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CROSSFADE_MS } from '../../src/scene/crossfade';
import {
  captureCasters,
  fadeDurationMs,
  setCasting,
  setDissolve,
  SWITCH_MEASURE,
  SWITCH_START_MARK,
} from '../../src/scene/dissolve';
import type { DissolveTarget } from '../../src/scene/dissolve';

type StampedMaterial = Material & { opacityNode?: unknown; alphaTestNode?: unknown };

/** The fields of a TSL node the graph walk in this file reads; values stay unknown. */
interface GraphNode {
  node?: unknown;
  aNode?: unknown;
  bNode?: unknown;
  rawInputs?: unknown[];
  op?: unknown;
  components?: unknown;
  value?: unknown;
}

/**
 * Steps through value holders such as VarNode, so assertions see the operator, split and
 * constant nodes behind them. A node is a holder when its only content is `.node`; operators
 * carry `op`, splits `components`, constants `value` and the hash call `rawInputs`.
 */
function unwrap(node: unknown): GraphNode | null {
  let current: unknown = node;
  for (;;) {
    if (typeof current !== 'object' || current === null) {
      return null;
    }
    const candidate = current as GraphNode;
    const holdsOneValue =
      candidate.node !== undefined &&
      candidate.op === undefined &&
      candidate.components === undefined &&
      candidate.value === undefined &&
      candidate.aNode === undefined &&
      candidate.bNode === undefined &&
      !Array.isArray(candidate.rawInputs);
    if (!holdsOneValue) {
      return candidate;
    }
    current = candidate.node;
  }
}

/** Collects every node reachable through the child slots three's node classes expose. */
function collectGraph(node: unknown, into: GraphNode[], depth = 0): void {
  const current = unwrap(node);
  if (!current || depth > 32 || into.includes(current)) {
    return;
  }
  into.push(current);
  collectGraph(current.node, into, depth + 1);
  collectGraph(current.aNode, into, depth + 1);
  collectGraph(current.bNode, into, depth + 1);
  if (Array.isArray(current.rawInputs)) {
    for (const input of current.rawInputs) {
      collectGraph(input, into, depth + 1);
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function fixture() {
  const materials = [new MeshStandardMaterial(), new MeshStandardMaterial()];
  const target: DissolveTarget = { materials: new Set(materials), opacity: uniform(1), casters: [] };
  return { target, materials };
}

describe('scene dissolve', () => {
  it('stamps every owned material with the live opacity and one shared threshold', () => {
    const { target, materials } = fixture();
    setDissolve(target, true);

    const threshold = (materials[0] as StampedMaterial).alphaTestNode;
    expect(threshold).toBeDefined();
    expect(threshold).not.toBeNull();
    for (const material of materials) {
      expect((material as StampedMaterial).opacityNode).toBe(target.opacity);
      expect((material as StampedMaterial).alphaTestNode).toBe(threshold);
      expect(material.transparent).toBe(false);
      expect(material.depthWrite).toBe(true);
    }
  });

  it('clears both node slots on every owned material', () => {
    const { target, materials } = fixture();
    setDissolve(target, true);
    setDissolve(target, false);

    for (const material of materials) {
      expect((material as StampedMaterial).opacityNode).toBeNull();
      expect((material as StampedMaterial).alphaTestNode).toBeNull();
    }
  });

  it('updates each material version once at each dissolve boundary', () => {
    const { target, materials } = fixture();
    const versions = materials.map((material) => material.version);
    setDissolve(target, true);
    expect(materials.map((material) => material.version)).toEqual(versions.map((value) => value + 1));

    // Advancing the shared uniform must not rebuild a material between the two boundaries.
    target.opacity.value = 0.5;
    setDissolve(target, true);
    expect(materials.map((material) => material.version)).toEqual(versions.map((value) => value + 1));
    setDissolve(target, false);
    expect(materials.map((material) => material.version)).toEqual(versions.map((value) => value + 2));
    setDissolve(target, false);
    expect(materials.map((material) => material.version)).toEqual(versions.map((value) => value + 2));
  });

  it('skips an already-stamped material without touching either slot or its version', () => {
    const { target, materials } = fixture();
    const stamped = materials[0] as StampedMaterial;
    // The guard keys on uniform identity. A sentinel in the other slot proves the whole stamp
    // is skipped, rather than merely suppressing needsUpdate after writing the slots again.
    stamped.opacityNode = target.opacity;
    const sentinel = uniform(0);
    stamped.alphaTestNode = sentinel;
    const version = materials[0].version;

    setDissolve(target, true);

    expect(stamped.opacityNode).toBe(target.opacity);
    expect(stamped.alphaTestNode).toBe(sentinel);
    expect(materials[0].version).toBe(version);
    expect((materials[1] as StampedMaterial).opacityNode).toBe(target.opacity);
  });

  it('leaves a material that never carried the dissolve untouched when the fade turns off', () => {
    const { target, materials } = fixture();
    const versions = materials.map((material) => material.version);

    // A slot that was never written reads as null, so clearing it would move the version for
    // nothing and make the renderer rebuild a material that never dissolved.
    setDissolve(target, false);

    expect(materials.map((material) => material.version)).toEqual(versions);
  });

  it('dissolves by the pcg hash of the screen pixel, seeded with y over the stride plus x', () => {
    const { target, materials } = fixture();
    setDissolve(target, true);
    const threshold = (materials[0] as StampedMaterial).alphaTestNode;

    // The threshold is a call over exactly one seed, not the raw seed expression: the hash is
    // what keeps the discard decision inside [0, 1).
    const call = unwrap(threshold);
    expect(Array.isArray(call?.rawInputs)).toBe(true);
    expect(call?.rawInputs).toHaveLength(1);

    const graph: GraphNode[] = [];
    collectGraph(threshold, graph);

    // The seed multiplies screen y by the shared row stride (8192, HASH_ROW_STRIDE in the
    // module), which is wider than any drawing buffer this page asks for, so two pixels of one
    // frame never sit on the same seed row.
    const strideMul = graph.find(
      (node) => node.op === '*' && unwrap(node.bNode)?.value === 8192,
    );
    expect(strideMul).toBeDefined();
    const ySplit = unwrap(strideMul?.aNode);
    expect(ySplit?.components).toBe('y');
    expect(ySplit?.node).toBe(screenCoordinate);

    // The seed adds screen x, so it is a function of the whole pixel and not of its row alone.
    const seedAdd = graph.find((node) => node.op === '+' && unwrap(node.aNode) === strideMul);
    expect(seedAdd).toBeDefined();
    const xSplit = unwrap(seedAdd?.bNode);
    expect(xSplit?.components).toBe('x');
    expect(xSplit?.node).toBe(screenCoordinate);
  });

  it('captures nested meshes and replaces stale caster records with their assigned flags', () => {
    const root = new Group();
    const nested = new Group();
    const casting = new Mesh();
    const noncasting = new Mesh();
    casting.castShadow = true;
    nested.add(casting, noncasting);
    root.add(nested);
    const stale = new Mesh();
    const loaded = { root, casters: [{ mesh: stale, assigned: true }] };

    captureCasters(loaded);

    expect(loaded.casters).toEqual([
      { mesh: casting, assigned: true }, { mesh: noncasting, assigned: false },
    ]);
  });

  it('parks every caster during the shadow handover', () => {
    const casting = new Mesh();
    const noncasting = new Mesh();
    casting.castShadow = true;
    const target = { casters: [
      { mesh: casting, assigned: true }, { mesh: noncasting, assigned: false },
    ] };

    setCasting(target, false);

    expect(casting.castShadow).toBe(false);
    expect(noncasting.castShadow).toBe(false);
  });

  it('restores each caster to its decorator-assigned flag', () => {
    const casting = new Mesh();
    const noncasting = new Mesh();
    // Start with both flags opposite to their captured values to prove both restoration paths.
    casting.castShadow = false;
    noncasting.castShadow = true;
    const target = { casters: [
      { mesh: casting, assigned: true }, { mesh: noncasting, assigned: false },
    ] };

    setCasting(target, true);

    expect(casting.castShadow).toBe(true);
    expect(noncasting.castShadow).toBe(false);
  });

  it('gives prefers-reduced-motion the instant swap, and only that exact query', () => {
    // The suite runs in node, so window is the stub; matching on the exact query string is what
    // tells a right reduce query from a malformed one.
    vi.stubGlobal('window', {
      matchMedia: (query: string) => ({ matches: query === '(prefers-reduced-motion: reduce)' }),
    });

    expect(fadeDurationMs()).toBe(0);
  });

  it('gives every other visitor the shared crossfade duration', () => {
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });

    expect(fadeDurationMs()).toBe(CROSSFADE_MS);
  });

  it('publishes the user timing names the switch timer and the proof panel agree on', () => {
    // src/proof/marks.ts reads 'look-switch' by literal name, so the exported pair is a
    // cross-module contract and not an internal label.
    expect(SWITCH_START_MARK).toBe('look-switch-start');
    expect(SWITCH_MEASURE).toBe('look-switch');
  });
});
