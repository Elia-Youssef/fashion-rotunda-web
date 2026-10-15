import { Group, Mesh, MeshStandardMaterial } from 'three/webgpu';
import type { Material } from 'three/webgpu';
import { uniform } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import { captureCasters, setCasting, setDissolve } from '../../src/scene/dissolve';
import type { DissolveTarget } from '../../src/scene/dissolve';

type StampedMaterial = Material & { opacityNode?: unknown; alphaTestNode?: unknown };

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
});
