import { describe, expect, it, vi } from 'vitest';
import {
  buildManifest,
  fileEntry,
  SET_NAMES,
  shippedJson,
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

describe('shippedJson', () => {
  it('matches JSON.stringify for ASCII content, two-space indented with a final newline', () => {
    const value = { name: 'Wallis Dress', sizes: [1, 2], nested: { ok: true } };
    expect(shippedJson(value)).toBe(`${JSON.stringify(value, null, 2)}\n`);
  });

  it('writes every character outside ASCII as an escape and keeps the parsed value', () => {
    const dash = String.fromCharCode(0x2013);
    const value = { description: `a different shape ${dash} had an influence`, mark: String.fromCodePoint(0x1f600) };
    const text = shippedJson(value);
    expect(text).toMatch(/^[\n\x20-\x7e]*$/);
    expect(text).toContain('\\u2013');
    expect(JSON.parse(text)).toEqual(value);
  });

  it('leaves the highest printable character, tilde, unescaped', () => {
    const value = { note: 'open 13:00~17:00, Mon~Fri' };
    expect(shippedJson(value)).toBe(`${JSON.stringify(value, null, 2)}\n`);
  });

  it('pads every escape to four hex digits, so a two-digit code point still parses', () => {
    const value = { word: 'caf\u00e9' };
    const text = shippedJson(value);
    expect(text).toContain('\\u00e9');
    expect(JSON.parse(text)).toEqual(value);
  });
});

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

  it('treats an omitted textures list as empty rather than crashing', () => {
    const bare = fileEntry({
      bytes: 100,
      triangles: 10,
      meshes: 1,
      nodes: 1,
      materials: 1,
      drawCalls: 1,
      textures: undefined as never,
    });
    expect(bare.textures).toEqual([]);
    expect(bare.gpuBytes).toBe(0);
    expect(bare.largestTexture).toBe(0);
    expect(bare.largestNonFloorTexture).toBe(0);
  });

  it('measures the largest texture on either axis, floor and non-floor separately', () => {
    const tall = textureEntry({
      name: 'Wall_B',
      width: 1024,
      height: 4096,
      format: 'ktx2-uastc',
      colorSpace: 'linear',
      bytes: 10,
    });
    const wideFloor = textureEntry({
      name: 'Floor_A',
      width: 2048,
      height: 512,
      format: 'ktx2-etc1s',
      colorSpace: 'srgb',
      bytes: 10,
      floor: true,
    });
    const entry = fileEntry({
      bytes: 20,
      triangles: 2,
      meshes: 2,
      nodes: 2,
      materials: 2,
      drawCalls: 2,
      textures: [tall, wideFloor],
    });
    expect(entry.largestTexture).toBe(4096);
    expect(entry.largestNonFloorTexture).toBe(4096);
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
    const manifest = buildManifest({ full: { 'rotunda.glb': rotunda } });
    expect(SET_NAMES).toEqual(['full', 'half']);
    expect(Object.keys(manifest.sets)).toEqual(['full', 'half']);
    expect(manifest.sets.half!.files).toEqual({});
    expect(manifest.sets.half!.totals).toEqual({ bytes: 0, gpuBytes: 0, triangles: 0 });
  });

  it('sorts the files map, because key order is part of byte-identical output', () => {
    const manifest = buildManifest({
      full: { 'rotunda.glb': rotunda, 'looks/zoot-suit.glb': look, 'plinth.glb': look },
    });
    expect(Object.keys(manifest.sets.full!.files)).toEqual([
      'looks/zoot-suit.glb',
      'plinth.glb',
      'rotunda.glb',
    ]);
  });

  it('serializes identical content across clock changes without generation metadata', () => {
    const sets = { full: { 'rotunda.glb': rotunda }, half: { 'looks/x.glb': look } };
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-19T20:30:00Z'));
      const first = shippedJson(buildManifest(sets));
      vi.setSystemTime(new Date('2027-10-17T10:00:00Z'));
      const second = shippedJson(buildManifest(sets));
      expect(second).toBe(first);
      expect(Object.keys(JSON.parse(first))).toEqual(['sets', 'errors']);
      expect(JSON.parse(first).errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a recorded texture failure, which is how a skipped texture stays visible', () => {
    const errors = [
      { set: 'full', file: 'rotunda.glb', texture: 'Floor_A_BaseColor', message: 'ktx exited 1' },
    ];
    expect(buildManifest({ full: {}, half: {} }, errors).errors).toEqual(errors);
  });
});
