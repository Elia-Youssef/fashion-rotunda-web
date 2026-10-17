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

  it('requires each set entry independently before updating a manifest', () => {
    const entry = { bytes: 10, triangles: 20, gpuBytes: 30 };
    const fullOnly = {
      sets: { full: { files: { 'a.glb': entry }, totals: {} }, half: { files: {}, totals: {} } }, errors: [],
    };
    expect(() => updateSelectedManifest(fullOnly, 'a.glb', { full: entry, half: entry }, [])).toThrow('requires existing');
    const halfOnly = {
      sets: { full: { files: {}, totals: {} }, half: { files: { 'a.glb': entry }, totals: {} } }, errors: [],
    };
    expect(() => updateSelectedManifest(halfOnly, 'a.glb', { full: entry, half: entry }, [])).toThrow('requires existing');
  });

  it('replaces the selected entry and recomputes totals in both sets', () => {
    const old = { bytes: 10, triangles: 20, gpuBytes: 30 };
    const rebuilt = { bytes: 15, triangles: 25, gpuBytes: 35 };
    const before = { sets: {
      full: { files: { 'a.glb': old, 'b.glb': old }, totals: {} },
      half: { files: { 'a.glb': old, 'b.glb': old }, totals: {} },
    }, errors: [] };
    const next = updateSelectedManifest(before, 'a.glb', { full: rebuilt, half: rebuilt }, []);
    expect(next.sets.full.files['a.glb']).toEqual(rebuilt);
    expect(next.sets.half.files['a.glb']).toEqual(rebuilt);
    expect(next.sets.full.totals).toEqual({ bytes: 25, triangles: 45, gpuBytes: 65 });
    expect(next.sets.half.totals).toEqual({ bytes: 25, triangles: 45, gpuBytes: 65 });
  });

  it('records the fresh texture errors in place of the replaced ones', () => {
    const entry = { bytes: 10, triangles: 20, gpuBytes: 30 };
    const before = { sets: {
      full: { files: { 'a.glb': entry }, totals: {} },
      half: { files: { 'a.glb': entry }, totals: {} },
    }, errors: [{ file: 'a.glb', message: 'stale' }, { file: 'b.glb', message: 'keep' }] };
    const next = updateSelectedManifest(before, 'a.glb', { full: entry, half: entry }, [
      { file: 'a.glb', message: 'fresh' },
    ]);
    expect(next.errors).toEqual([{ file: 'b.glb', message: 'keep' }, { file: 'a.glb', message: 'fresh' }]);
  });

  it('fails closed when the candidate catalogue lacks the selected look', () => {
    const before = { views: { proof: 'keep' }, looks: [{ id: 'mondrian-dress', name: 'old' }] };
    const candidate = { looks: [{ id: 'other', name: 'replace' }] };
    expect(() => updateSelectedCatalog(before, candidate, 'mondrian-dress')).toThrow('one existing');
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
