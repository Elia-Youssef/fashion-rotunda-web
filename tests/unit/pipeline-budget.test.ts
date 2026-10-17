import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
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
import type { Manifest } from '../../pipeline/gltf/lib/manifest.mjs';

// gpuBytes is the only number in the project with no runtime instrument behind it: renderer.info
// reports texture counts, not bytes. The proof panel and the budget report both print this, so the
// formula is pinned digit by digit against the worked example in the manifest data contract.

// Decimal megabytes, the unit budget.mjs uses for its targets and its printout.
const MB = 1_000_000;
// The measured opening scene bodies before the phone texture reduction, excluding HTTP overhead.
const PREVIOUS_PHONE_OPENING_BYTES = 4_503_656;
const REQUIRED_PHONE_OPENING_SAVING = 1_500_000;

describe('shipped phone budget rows', () => {
  const manifest = JSON.parse(readFileSync('public/content/manifest.json', 'utf8')) as Manifest;
  const catalog = JSON.parse(readFileSync('public/content/half/catalog.json', 'utf8')) as {
    rotunda: { file: string }; plinth: { file: string }; looks: { file: string }[];
  };
  const files = manifest.sets['half']!.files;
  const firstLook = catalog.looks[0]!.file;
  const measured = budgetRows('half', files, firstLook, null);

  it('saves at least 1500000 bytes in the three opening files without changing the default look', () => {
    expect(firstLook).toBe('looks/wallis-dress.glb');
    const names = [catalog.rotunda.file, catalog.plinth.file, firstLook];
    const diskBytes = names.reduce((sum, name) => {
      const bytes = statSync('public/content/half/' + name).size;
      expect(files[name]?.bytes, name).toBe(bytes);
      return sum + bytes;
    }, 0);
    expect(measured.rows.find((r) => r.key === 'firstFrameBytes')?.actual).toBe(diskBytes);
    expect(PREVIOUS_PHONE_OPENING_BYTES - diskBytes).toBeGreaterThanOrEqual(REQUIRED_PHONE_OPENING_SAVING);
  });

  it('reports the smaller texture and payload rows against the existing phone allowances', () => {
    expect(measured.rows.every((r) => r.pass)).toBe(true);
    expect(measured.rows.find((r) => r.key === 'largestTexture')?.actual).toBeLessThanOrEqual(512);
    expect(measured.rows.find((r) => r.key === 'largestNonFloorTexture')?.actual).toBeLessThanOrEqual(512);
    expect(formatBudgetTable('half', measured.rows, measured.info))
      .toContain('encoding caps 512 px colour/data, 512 px floor, 256 px mannequin, 256/256 px static/garment normals');
    expect(manifest.errors).toEqual([]);
  });
});

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
      lookTriangles: 340000,
      trianglesInView: 450000,
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
      trianglesInView: 300000,
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
    'env/school-field-cloudy-1k.hdr': fileEntry({
      bytes: 1 * MB,
      triangles: 0,
      meshes: 0,
      nodes: 0,
      materials: 0,
      drawCalls: 0,
      textures: [],
    }),
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
  const { rows, info } = budgetRows(
    'full',
    files(),
    'looks/wallis-dress.glb',
    'env/school-field-cloudy-1k.hdr',
  );
  const row = (key: string) => rows.find((entry) => entry.key === key)!;

  it('prints every budget in the table, in order', () => {
    expect(rows.map((entry) => entry.key)).toEqual([
      'sceneTriangles',
      'lookTriangles',
      'trianglesInView',
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

  it('bounds the triangles in view by the rotunda, the plinth and the heaviest look', () => {
    expect(row('trianglesInView').actual).toBe(69124 + 422 + 127170);
    expect(row('trianglesInView').target).toBe(450000);
    expect(row('trianglesInView').pass).toBe(true);
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
    // Rotunda 6 + plinth 2 + first look 1. The environment file is not fetched by default.
    expect(row('firstFrameBytes').actual).toBe(9 * MB);
    expect(row('firstFrameBytes').pass).toBe(true);
    expect(row('furtherLookBytes').actual).toBe(9 * MB);
    expect(row('furtherLookBytes').pass).toBe(false);
  });

  it('measures the phone set against the phone targets', () => {
    const half = budgetRows(
      'half',
      files(),
      'looks/wallis-dress.glb',
      'env/school-field-cloudy-1k.hdr',
    );
    expect(half.rows.find((entry) => entry.key === 'lookTriangles')!.pass).toBe(false);
    expect(half.rows.find((entry) => entry.key === 'drawCalls')!.target).toBe(80);
  });

  it('keeps the ?sky=hdr environment out of the payload row and reports it apart', () => {
    expect(info.environmentFile).toBe('env/school-field-cloudy-1k.hdr');
    expect(info.environmentBytes).toBe(1 * MB);
    const without = budgetRows('full', files(), 'looks/wallis-dress.glb', null);
    expect(without.rows.find((entry) => entry.key === 'firstFrameBytes')!.actual).toBe(9 * MB);
    expect(without.info.environmentFile).toBeNull();
    expect(without.info.environmentBytes).toBe(0);
  });

  it('refuses a set it does not know', () => {
    expect(() =>
      budgetRows(
        'quarter' as never,
        files(),
        'looks/wallis-dress.glb',
        'env/school-field-cloudy-1k.hdr',
      ),
    ).toThrow(/unknown set/);
  });
});

function staticFile(bytes: number, triangles: number, drawCalls: number, textures: ReturnType<typeof texture>[]) {
  return fileEntry({ bytes, triangles, meshes: 1, nodes: 1, materials: 1, drawCalls, textures });
}

function lookFile(entry: { bytes: number; triangles: number; drawCalls: number; textures: ReturnType<typeof texture>[] }) {
  return fileEntry({
    bytes: entry.bytes,
    triangles: entry.triangles,
    meshes: 2,
    nodes: 4,
    materials: 4,
    drawCalls: entry.drawCalls,
    textures: entry.textures,
  });
}

// Manifests the shipped sets never produce, but a partial optimize run or a hand edit can. The
// usual fixtures leave these contracts unobservable: their looks never tie, the heaviest look is
// heaviest by every measure at once, and every named file is present.
describe('budgetRows on partial, tied and single-look manifests', () => {
  it('reads a manifest without the rotunda and plinth as zeros instead of failing', () => {
    const only = lookFile({ bytes: 1 * MB, triangles: 5000, drawCalls: 3, textures: [texture(512, 'ktx2-etc1s', 10)] });
    const { rows } = budgetRows('full', { 'looks/only-look.glb': only }, 'looks/only-look.glb', null);
    const row = (key: string) => rows.find((entry) => entry.key === key)!;
    expect(row('sceneTriangles').actual).toBe(0);
    expect(row('trianglesInView').actual).toBe(5000);
    expect(row('drawCalls').actual).toBe(3);
    expect(row('gpuTextureBytes').actual).toBe(only.gpuBytes);
    expect(row('firstFrameBytes').actual).toBe(1 * MB);
  });

  it('reports a named environment that is not among the files as absent', () => {
    const { info } = budgetRows('full', files(), 'looks/wallis-dress.glb', 'env/not-in-the-set.hdr');
    expect(info.environmentFile).toBeNull();
    expect(info.environmentBytes).toBe(0);
  });

  it('measures a set with no looks without failing and names no heaviest look', () => {
    const base = files();
    const lookless = {
      'env/school-field-cloudy-1k.hdr': base['env/school-field-cloudy-1k.hdr']!,
      'rotunda.glb': base['rotunda.glb']!,
      'plinth.glb': base['plinth.glb']!,
    };
    const { rows, info } = budgetRows('full', lookless, 'looks/absent.glb', null);
    const row = (key: string) => rows.find((entry) => entry.key === key)!;
    expect(row('lookTriangles').actual).toBe(0);
    expect(row('trianglesInView').actual).toBe(base['rotunda.glb']!.triangles + base['plinth.glb']!.triangles);
    expect(row('furtherLookBytes').actual).toBe(0);
    expect(info.heaviestLookByGpu).toBeNull();
    expect(info.heaviestLookByTriangles).toBeNull();
    const text = formatBudgetTable('full', rows, info);
    expect(text).toContain('heaviest look by GPU bytes -, by triangles -');
    expect(text).not.toContain('none');
  });

  it('names the lexicographically first look when two looks tie, whatever the key order', () => {
    const tied = lookFile({ bytes: 2 * MB, triangles: 90000, drawCalls: 2, textures: [texture(1024, 'ktx2-etc1s', 10)] });
    const base = files();
    const { info } = budgetRows(
      'full',
      {
        'rotunda.glb': base['rotunda.glb']!,
        'plinth.glb': base['plinth.glb']!,
        'looks/zz-tied.glb': tied,
        'looks/aa-tied.glb': tied,
      },
      'looks/aa-tied.glb',
      null,
    );
    expect(info.heaviestLookByTriangles).toBe('looks/aa-tied.glb');
    expect(info.heaviestLookByGpu).toBe('looks/aa-tied.glb');
  });

  it('ranks the heaviest look by triangles and GPU bytes, not by disk size or draw calls', () => {
    const base = files();
    const diskHeavy = lookFile({ bytes: 9 * MB, triangles: 10000, drawCalls: 9, textures: [texture(512, 'ktx2-etc1s', 10)] });
    const gpuHeavy = lookFile({ bytes: 1 * MB, triangles: 120000, drawCalls: 1, textures: [texture(2048, 'ktx2-uastc', 10)] });
    const { rows, info } = budgetRows(
      'full',
      {
        'rotunda.glb': base['rotunda.glb']!,
        'plinth.glb': base['plinth.glb']!,
        'looks/disk-heavy.glb': diskHeavy,
        'looks/gpu-heavy.glb': gpuHeavy,
      },
      'looks/gpu-heavy.glb',
      null,
    );
    const row = (key: string) => rows.find((entry) => entry.key === key)!;
    expect(row('lookTriangles').actual).toBe(120000);
    expect(info.heaviestLookByTriangles).toBe('looks/gpu-heavy.glb');
    expect(info.heaviestLookByGpu).toBe('looks/gpu-heavy.glb');
    expect(row('gpuTextureBytes').actual)
      .toBe(base['rotunda.glb']!.gpuBytes + base['plinth.glb']!.gpuBytes + gpuHeavy.gpuBytes);
  });

  it('measures the largest texture over every file, including looks that are not resident', () => {
    const residentLook = lookFile({
      bytes: 2 * MB,
      triangles: 30000,
      drawCalls: 2,
      textures: [texture(1024, 'ktx2-uastc', 10), texture(1024, 'ktx2-uastc', 10), texture(1024, 'ktx2-uastc', 10)],
    });
    const wideLook = lookFile({ bytes: 1 * MB, triangles: 5000, drawCalls: 2, textures: [texture(2048, 'ktx2-etc1s', 10)] });
    const { rows, info } = budgetRows(
      'full',
      {
        'rotunda.glb': staticFile(3 * MB, 60000, 10, [texture(512, 'ktx2-etc1s', 10, true)]),
        'plinth.glb': staticFile(1 * MB, 400, 1, [texture(256, 'ktx2-etc1s', 10)]),
        'looks/gpu-heavy.glb': residentLook,
        'looks/wide-but-light.glb': wideLook,
      },
      'looks/gpu-heavy.glb',
      null,
    );
    const row = (key: string) => rows.find((entry) => entry.key === key)!;
    expect(info.heaviestLookByGpu).toBe('looks/gpu-heavy.glb');
    expect(row('largestTexture').actual).toBe(2048);
    expect(row('largestNonFloorTexture').actual).toBe(2048);
  });

  it('excludes the first look from the further-look row and reads 0 with a single look', () => {
    const base = files();
    const first = lookFile({ bytes: 5 * MB, triangles: 60000, drawCalls: 2, textures: [texture(512, 'ktx2-etc1s', 10)] });
    const mid = lookFile({ bytes: 3 * MB, triangles: 20000, drawCalls: 2, textures: [texture(512, 'ktx2-etc1s', 10)] });
    const light = lookFile({ bytes: 1 * MB, triangles: 10000, drawCalls: 2, textures: [texture(2048, 'ktx2-uastc', 10)] });
    const three = budgetRows(
      'full',
      {
        'rotunda.glb': base['rotunda.glb']!,
        'plinth.glb': base['plinth.glb']!,
        'looks/first.glb': first,
        'looks/mid.glb': mid,
        'looks/light.glb': light,
      },
      'looks/first.glb',
      null,
    );
    expect(three.rows.find((entry) => entry.key === 'furtherLookBytes')?.actual).toBe(3 * MB);
    const single = budgetRows(
      'full',
      { 'rotunda.glb': base['rotunda.glb']!, 'plinth.glb': base['plinth.glb']!, 'looks/first.glb': first },
      'looks/first.glb',
      null,
    );
    expect(single.rows.find((entry) => entry.key === 'furtherLookBytes')?.actual).toBe(0);
  });
});

describe('formatBudgetTable', () => {
  const { rows, info } = budgetRows(
    'full',
    files(),
    'looks/wallis-dress.glb',
    'env/school-field-cloudy-1k.hdr',
  );
  const text = formatBudgetTable('full', rows, info);

  it('names the set and marks a miss so it cannot be read as a pass', () => {
    expect(text).toContain('budget: full set');
    expect(text).toContain('MISS');
    expect(text.split('\n').filter((line) => line.includes('MISS'))).toHaveLength(1);
  });

  it('prints the environment as a diagnostic-only line, not a budget row', () => {
    const line = text.split('\n').find((entry) => entry.includes('env/school-field-cloudy-1k.hdr'));
    expect(line).toContain('1.00 MB');
    expect(line).toContain('?sky=hdr diagnostic only');
    expect(line).toContain('note:');
  });

  it('prints byte rows in MB and count rows as counts', () => {
    expect(text).toContain('9.00 MB');
    expect(text).toContain('10.00 MB');
    expect(text).toContain('69546');
  });

  it('prints the desktop encoding caps for the full set, where they differ from the floor cap', () => {
    expect(text).toContain('encoding caps 2048 px colour/data, 4096 px floor, 512 px mannequin, 1024/1024 px static/garment normals');
  });

  it('formats megabytes the way inspect.mjs does', () => {
    expect(formatMb(MB)).toBe('1.00 MB');
    expect(formatMb(0)).toBe('0.00 MB');
  });
});
