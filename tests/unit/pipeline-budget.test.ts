import { describe, expect, it } from 'vitest';
import {
  BUDGETS,
  BYTES_PER_PIXEL,
  budgetRows,
  formatBudgetTable,
  formatMb,
  gpuBytes,
  MIP_FACTOR,
} from '../../pipeline/gltf/lib/budget.mjs';
import { fileEntry, textureEntry } from '../../pipeline/gltf/lib/manifest.mjs';

// gpuBytes is the only number in the project with no runtime instrument behind it: renderer.info
// reports texture counts, not bytes. The proof panel and the budget report both print this, so the
// formula is pinned digit by digit against the worked example in the manifest data contract.

const MB = 1048576;

describe('gpuBytes', () => {
  it('pins the mip factor and the bytes per pixel of each format', () => {
    expect(MIP_FACTOR).toBe(1.333);
    expect(BYTES_PER_PIXEL).toEqual({ 'ktx2-uastc': 1, 'ktx2-etc1s': 0.5, png: 4, jpeg: 4 });
  });

  it('gives a 2048 UASTC texture 2048 x 2048 x 1 x 1.333 bytes', () => {
    expect(gpuBytes(2048, 2048, 'ktx2-uastc')).toBe(Math.round(2048 * 2048 * 1 * 1.333));
    expect(gpuBytes(2048, 2048, 'ktx2-uastc')).toBe(5591007);
  });

  it('gives a 2048 ETC1S texture half of that', () => {
    expect(gpuBytes(2048, 2048, 'ktx2-etc1s')).toBe(2795504);
    expect(gpuBytes(2048, 2048, 'ktx2-etc1s') * 2).toBeCloseTo(gpuBytes(2048, 2048, 'ktx2-uastc'), -1);
  });

  it('gives an uncompressed image four bytes a pixel', () => {
    expect(gpuBytes(2048, 2048, 'png')).toBe(22364029);
    expect(gpuBytes(512, 512, 'jpeg')).toBe(gpuBytes(512, 512, 'png'));
  });

  it('scales with area, so halving a side quarters the cost', () => {
    expect(gpuBytes(1024, 1024, 'ktx2-etc1s')).toBe(698876);
    expect(gpuBytes(512, 512, 'ktx2-uastc')).toBe(349438);
    expect(gpuBytes(2048, 1024, 'ktx2-uastc')).toBe(2795504);
  });

  it('refuses a format it has no block size for', () => {
    expect(() => gpuBytes(64, 64, 'ktx2-astc' as never)).toThrow(/unknown format/);
  });
});

describe('BUDGETS', () => {
  it('pins the desktop row of the budget table', () => {
    expect(BUDGETS.full).toEqual({
      sceneTriangles: 200000,
      lookTriangles: 160000,
      drawCalls: 150,
      gpuTextureBytes: 400 * MB,
      largestTexture: 4096,
      largestNonFloorTexture: 2048,
      firstFrameBytes: 10 * MB,
      furtherLookBytes: 6 * MB,
    });
  });

  it('pins the phone row of the budget table', () => {
    expect(BUDGETS.half).toEqual({
      sceneTriangles: 200000,
      lookTriangles: 120000,
      drawCalls: 80,
      gpuTextureBytes: 150 * MB,
      largestTexture: 2048,
      largestNonFloorTexture: 1024,
      firstFrameBytes: 6 * MB,
      furtherLookBytes: 3.5 * MB,
    });
  });
});

function texture(width: number, format: 'ktx2-uastc' | 'ktx2-etc1s', bytes: number, floor = false) {
  return textureEntry({
    name: `t${width}${format}${floor ? '-floor' : ''}`,
    width,
    height: width,
    format,
    colorSpace: 'linear',
    bytes,
    floor,
  });
}

function files() {
  return {
    'rotunda.glb': fileEntry({
      bytes: 6 * MB,
      triangles: 69124,
      meshes: 10,
      nodes: 20,
      materials: 9,
      drawCalls: 17,
      textures: [texture(2048, 'ktx2-etc1s', 1000, true), texture(1024, 'ktx2-uastc', 2000)],
    }),
    'plinth.glb': fileEntry({
      bytes: 2 * MB,
      triangles: 422,
      meshes: 1,
      nodes: 1,
      materials: 1,
      drawCalls: 1,
      textures: [texture(1024, 'ktx2-etc1s', 500)],
    }),
    'looks/wallis-dress.glb': fileEntry({
      bytes: 1 * MB,
      triangles: 10044,
      meshes: 2,
      nodes: 4,
      materials: 4,
      drawCalls: 2,
      textures: [texture(1024, 'ktx2-etc1s', 300)],
    }),
    'looks/geoffrey-beene.glb': fileEntry({
      bytes: 9 * MB,
      triangles: 127170,
      meshes: 2,
      nodes: 4,
      materials: 4,
      drawCalls: 2,
      textures: [texture(2048, 'ktx2-uastc', 900)],
    }),
  };
}

describe('budgetRows', () => {
  const { rows, info } = budgetRows('full', files(), 'looks/wallis-dress.glb');
  const row = (key: string) => rows.find((entry) => entry.key === key)!;

  it('prints every budget in the table, in order', () => {
    expect(rows.map((entry) => entry.key)).toEqual([
      'sceneTriangles',
      'lookTriangles',
      'drawCalls',
      'gpuTextureBytes',
      'largestTexture',
      'largestNonFloorTexture',
      'firstFrameBytes',
      'furtherLookBytes',
    ]);
  });

  it('adds the rotunda and the plinth for the scene triangle row', () => {
    expect(row('sceneTriangles').actual).toBe(69124 + 422);
    expect(row('sceneTriangles').pass).toBe(true);
  });

  it('takes the heaviest look, not the sum of the looks', () => {
    expect(row('lookTriangles').actual).toBe(127170);
    expect(info.heaviestLookByTriangles).toBe('looks/geoffrey-beene.glb');
  });

  it('counts texture memory as the resident set: rotunda, plinth and one look', () => {
    // Seven looks never coexist on the GPU, so the sum over all files would be a number the page
    // never reaches. The all-files figure is reported beside it as information.
    const resident = gpuBytes(2048, 2048, 'ktx2-etc1s') + gpuBytes(1024, 1024, 'ktx2-uastc') +
      gpuBytes(1024, 1024, 'ktx2-etc1s') + gpuBytes(2048, 2048, 'ktx2-uastc');
    expect(row('gpuTextureBytes').actual).toBe(resident);
    expect(info.allFilesGpuBytes).toBeGreaterThan(resident);
    expect(info.heaviestLookByGpu).toBe('looks/geoffrey-beene.glb');
  });

  it('separates the floor texture from the rest for the size rows', () => {
    expect(row('largestTexture').actual).toBe(2048);
    expect(row('largestNonFloorTexture').actual).toBe(2048);
  });

  it('adds the first look, not the heaviest, for the payload row', () => {
    expect(row('firstFrameBytes').actual).toBe(9 * MB);
    expect(row('firstFrameBytes').pass).toBe(true);
    expect(row('furtherLookBytes').actual).toBe(9 * MB);
    expect(row('furtherLookBytes').pass).toBe(false);
  });

  it('measures the phone set against the phone targets', () => {
    const half = budgetRows('half', files(), 'looks/wallis-dress.glb');
    expect(half.rows.find((entry) => entry.key === 'lookTriangles')!.pass).toBe(false);
    expect(half.rows.find((entry) => entry.key === 'drawCalls')!.target).toBe(80);
  });

  it('refuses a set it does not know', () => {
    expect(() => budgetRows('quarter' as never, files(), 'looks/wallis-dress.glb')).toThrow(/unknown set/);
  });
});

describe('formatBudgetTable', () => {
  const { rows, info } = budgetRows('full', files(), 'looks/wallis-dress.glb');
  const text = formatBudgetTable('full', rows, info);

  it('names the set and marks a miss so it cannot be read as a pass', () => {
    expect(text).toContain('budget: full set');
    expect(text).toContain('MISS');
    expect(text.split('\n').filter((line) => line.includes('MISS'))).toHaveLength(1);
  });

  it('prints byte rows in MB and count rows as counts', () => {
    expect(text).toContain('10.00 MB');
    expect(text).toContain('69546');
  });

  it('formats megabytes the way inspect.mjs does', () => {
    expect(formatMb(MB)).toBe('1.00 MB');
    expect(formatMb(0)).toBe('0.00 MB');
  });
});
