import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  fileEntry,
  SET_NAMES,
  textureEntry,
  totalsOf,
} from '../../pipeline/gltf/lib/manifest.mjs';
import { gpuBytes } from '../../pipeline/gltf/lib/budget.mjs';

// manifest.json is the contract between the pipeline and the loader, and the only place the page
// can read texture memory from. The shape is fixed by the manifest data contract.

function texture(name: string, width: number, format: 'ktx2-uastc' | 'ktx2-etc1s', floor = false) {
  return textureEntry({
    name,
    width,
    height: width,
    format,
    colorSpace: format === 'ktx2-uastc' ? 'linear' : 'srgb',
    bytes: 1000,
    floor,
  });
}

describe('textureEntry', () => {
  it('carries the contract fields and derives gpuBytes rather than trusting a caller', () => {
    const entry = textureEntry({
      name: 'Floor_A_BaseColor',
      width: 4096,
      height: 4096,
      format: 'ktx2-etc1s',
      colorSpace: 'srgb',
      bytes: 456789,
    });
    expect(entry).toEqual({
      name: 'Floor_A_BaseColor',
      width: 4096,
      height: 4096,
      format: 'ktx2-etc1s',
      colorSpace: 'srgb',
      bytes: 456789,
      gpuBytes: gpuBytes(4096, 4096, 'ktx2-etc1s'),
      floor: false,
    });
  });

  it('records the floor flag, which is what tells the two size budgets apart', () => {
    expect(texture('a', 4096, 'ktx2-etc1s', true).floor).toBe(true);
  });
});

describe('fileEntry', () => {
  const entry = fileEntry({
    bytes: 1234567,
    triangles: 81234,
    meshes: 12,
    nodes: 40,
    materials: 9,
    drawCalls: 17,
    textures: [texture('floor', 4096, 'ktx2-etc1s', true), texture('wall', 2048, 'ktx2-uastc')],
  });

  it('sums its textures onto the file', () => {
    expect(entry.gpuBytes).toBe(gpuBytes(4096, 4096, 'ktx2-etc1s') + gpuBytes(2048, 2048, 'ktx2-uastc'));
  });

  it('records the largest texture with and without the floor', () => {
    expect(entry.largestTexture).toBe(4096);
    expect(entry.largestNonFloorTexture).toBe(2048);
  });

  it('survives a file with no textures at all', () => {
    const bare = fileEntry({
      bytes: 100,
      triangles: 10,
      meshes: 1,
      nodes: 1,
      materials: 1,
      drawCalls: 1,
      textures: [],
    });
    expect(bare.gpuBytes).toBe(0);
    expect(bare.largestTexture).toBe(0);
    expect(bare.largestNonFloorTexture).toBe(0);
  });
});

describe('totalsOf and buildManifest', () => {
  const rotunda = fileEntry({
    bytes: 1000,
    triangles: 100,
    meshes: 1,
    nodes: 1,
    materials: 1,
    drawCalls: 1,
    textures: [texture('a', 1024, 'ktx2-etc1s')],
  });
  const look = fileEntry({
    bytes: 2000,
    triangles: 200,
    meshes: 1,
    nodes: 1,
    materials: 1,
    drawCalls: 1,
    textures: [texture('b', 512, 'ktx2-uastc')],
  });

  it('adds bytes, gpuBytes and triangles across a set', () => {
    expect(totalsOf({ 'rotunda.glb': rotunda, 'looks/x.glb': look })).toEqual({
      bytes: 3000,
      gpuBytes: rotunda.gpuBytes + look.gpuBytes,
      triangles: 300,
    });
  });

  it('always carries both sets, even when one was not built', () => {
    const manifest = buildManifest('2026-09-19T20:30:00Z', { full: { 'rotunda.glb': rotunda } });
    expect(SET_NAMES).toEqual(['full', 'half']);
    expect(Object.keys(manifest.sets)).toEqual(['full', 'half']);
    expect(manifest.sets.half!.files).toEqual({});
    expect(manifest.sets.half!.totals).toEqual({ bytes: 0, gpuBytes: 0, triangles: 0 });
  });

  it('sorts the files map, because key order is part of byte-identical output', () => {
    const manifest = buildManifest('2026-09-19T20:30:00Z', {
      full: { 'rotunda.glb': rotunda, 'looks/zoot-suit.glb': look, 'plinth.glb': look },
    });
    expect(Object.keys(manifest.sets.full!.files)).toEqual([
      'looks/zoot-suit.glb',
      'plinth.glb',
      'rotunda.glb',
    ]);
  });

  it('carries the generated stamp and an errors array that defaults to empty', () => {
    const manifest = buildManifest('2026-09-19T20:30:00Z', { full: {}, half: {} });
    expect(manifest.generated).toBe('2026-09-19T20:30:00Z');
    expect(manifest.errors).toEqual([]);
  });

  it('keeps a recorded texture failure, which is how a skipped texture stays visible', () => {
    const errors = [
      { set: 'full', file: 'rotunda.glb', texture: 'Floor_A_BaseColor', message: 'ktx exited 1' },
    ];
    expect(buildManifest('2026-09-19T20:30:00Z', { full: {}, half: {} }, errors).errors).toEqual(errors);
  });
});
