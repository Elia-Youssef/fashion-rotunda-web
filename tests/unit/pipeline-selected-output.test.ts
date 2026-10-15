import { describe, expect, it } from 'vitest';
import { selectLook, updateSelectedCatalog, updateSelectedManifest } from '../../pipeline/gltf/lib/selected-output.mjs';

describe('one look regeneration', () => {
  it('selects one exact look and rejects broad, unknown or duplicate selections', () => {
    const plan = [{ file: 'looks/mondrian-dress.glb', look: { id: 'mondrian-dress' } },
      { file: 'looks/wallis-dress.glb', look: { id: 'wallis-dress' } }, { file: 'rotunda.glb' }];
    expect(selectLook(plan, 'mondrian-dress')).toEqual([plan[0]]);
    expect(() => selectLook(plan, 'dress')).toThrow('exactly one');
    expect(() => selectLook([...plan, plan[0]], 'mondrian-dress')).toThrow('exactly one');
  });

  it('preserves unrelated entries and generation date while recalculating dependent totals', () => {
    const old = { bytes: 10, triangles: 20, gpuBytes: 30 };
    const before = { generated: 'unchanged', sets: {
      full: { files: { 'looks/mondrian-dress.glb': old, 'other.glb': old }, totals: {} },
      half: { files: { 'looks/mondrian-dress.glb': old, 'other.glb': old }, totals: {} },
    }, errors: [{ file: 'other.glb', message: 'keep' }] };
    const next = updateSelectedManifest(before, 'looks/mondrian-dress.glb', {
      full: { bytes: 15, triangles: 20, gpuBytes: 30 }, half: old,
    }, []);
    expect(next.generated).toBe(before.generated);
    expect(next.errors).toEqual(before.errors);
    expect(next.sets.full.files['other.glb']).toEqual(old);
    expect(next.sets.half.files['other.glb']).toEqual(old);
    expect(next.sets.full.totals).toEqual({ bytes: 25, triangles: 40, gpuBytes: 60 });
    expect(before.sets.full.files['looks/mondrian-dress.glb']).toEqual(old);
    expect(() => updateSelectedManifest(before, 'missing.glb', { full: old, half: old }, [])).toThrow('requires existing');
    expect(() => updateSelectedManifest(before, 'looks/mondrian-dress.glb', { full: old, half: old }, [{ file: 'other.glb' }]))
      .toThrow('Unrelated');
  });

  it('changes only selected catalogue metadata and fails closed on missing identities', () => {
    const before = { views: { proof: 'keep' }, looks: [{ id: 'mondrian-dress', name: 'old' }, { id: 'other', name: 'keep' }] };
    const candidate = { looks: [{ id: 'mondrian-dress', name: 'new' }, { id: 'other', name: 'replace' }] };
    expect(updateSelectedCatalog(before, candidate, 'mondrian-dress')).toEqual({
      views: before.views, looks: [candidate.looks[0], before.looks[1]],
    });
    expect(() => updateSelectedCatalog(before, candidate, 'missing')).toThrow('one existing');
  });

  it('rejects a before-catalogue that already holds the look twice', () => {
    const before = { looks: [{ id: 'mondrian-dress', name: 'old' }, { id: 'mondrian-dress', name: 'repeat' }] };
    const candidate = { looks: [{ id: 'mondrian-dress', name: 'new' }] };
    expect(() => updateSelectedCatalog(before, candidate, 'mondrian-dress'))
      .toThrow('Selected rebuild requires one existing catalogue entry for mondrian-dress');
  });
});
