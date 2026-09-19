// The budget table and the one formula behind its heaviest row.
//
// Texture memory has no runtime instrument: renderer.info reports counts, not bytes. So the number
// the proof panel shows is computed here from each texture's dimensions and format, and a row that
// misses is printed as a miss rather than hidden.
//
// Targets come from the project budget table and from nowhere else. Change them there first.

import { FLOOR_MESH_NAME } from './sizing.mjs';

/**
 * Mip chain overhead. A full chain adds 1/4 + 1/16 + ... = 1/3 of the base level, and the data
 * contract for the manifest writes that as 1.333, so 1.333 is what is used:
 * the manifest and the contract have to produce the same number.
 */
export const MIP_FACTOR = 1.333;

/** Bytes per pixel on the GPU, after transcoding. KTX2 numbers are the block sizes of the target formats. */
export const BYTES_PER_PIXEL = {
  'ktx2-uastc': 1,
  'ktx2-etc1s': 0.5,
  png: 4,
  jpeg: 4,
};

/** Bytes a texture occupies on the GPU once uploaded, mip chain included. */
export function gpuBytes(width, height, format) {
  const perPixel = BYTES_PER_PIXEL[format];
  if (perPixel === undefined) throw new Error(`gpuBytes: unknown format "${format}"`);
  return Math.round(width * height * perPixel * MIP_FACTOR);
}

const MB = 1048576;

/**
 * One row per budget, per set. `target` is the number the budget table states; `unit` says how to print it.
 *
 * "resident" is the set actually on the GPU at one time: the rotunda, the plinth and one look. The
 * page disposes a look's GPU resources when it is replaced, so seven looks never coexist. The
 * all-files total is printed beside it as information, not as a gate.
 */
export const BUDGETS = {
  full: {
    sceneTriangles: 200000,
    lookTriangles: 160000,
    drawCalls: 150,
    gpuTextureBytes: 400 * MB,
    largestTexture: 4096,
    largestNonFloorTexture: 2048,
    firstFrameBytes: 10 * MB,
    furtherLookBytes: 6 * MB,
  },
  half: {
    sceneTriangles: 200000,
    lookTriangles: 120000,
    drawCalls: 80,
    gpuTextureBytes: 150 * MB,
    largestTexture: 2048,
    largestNonFloorTexture: 1024,
    firstFrameBytes: 6 * MB,
    furtherLookBytes: 3.5 * MB,
  },
};

/** Human labels, in print order. The floor row names the mesh so the 4096 allowance is traceable. */
const ROW_LABELS = {
  sceneTriangles: 'rotunda plus plinth, triangles',
  lookTriangles: 'heaviest look incl. mannequin, triangles',
  drawCalls: 'draw calls, rotunda + plinth + one look',
  gpuTextureBytes: 'texture memory on the GPU, resident',
  largestTexture: `largest texture (${FLOOR_MESH_NAME} allowed the wider cap)`,
  largestNonFloorTexture: 'largest texture, other materials',
  firstFrameBytes: 'payload to first frame',
  furtherLookBytes: 'heaviest further look',
};

const BYTE_ROWS = new Set(['gpuTextureBytes', 'firstFrameBytes', 'furtherLookBytes']);

/**
 * Measures one set of the manifest against its budgets.
 *
 * @param set 'full' or 'half'.
 * @param files the manifest's `sets[set].files` object.
 * @param firstLook the catalogue's first look file, for the payload row.
 * @returns `{ rows, info }`, rows carrying `{ key, label, actual, target, unit, pass }`.
 */
export function budgetRows(set, files, firstLook) {
  const targets = BUDGETS[set];
  if (!targets) throw new Error(`budgetRows: unknown set "${set}"`);
  const entry = (name) => files[name] ?? null;
  const looks = Object.keys(files)
    .filter((name) => name.startsWith('looks/'))
    .sort();
  const lookEntries = looks.map((name) => ({ name, ...files[name] }));
  const heaviestTriangles = maxBy(lookEntries, (look) => look.triangles);
  const rotunda = entry('rotunda.glb');
  const plinth = entry('plinth.glb');

  const sceneTriangles = num(rotunda?.triangles) + num(plinth?.triangles);
  const resident = [rotunda, plinth, heaviestGpu(lookEntries)];
  const firstFrame = [rotunda, plinth, entry(firstLook)];
  const further = lookEntries.filter((look) => look.name !== firstLook);

  const actual = {
    sceneTriangles,
    lookTriangles: num(heaviestTriangles?.triangles),
    drawCalls: sum(resident, (file) => num(file?.drawCalls)),
    gpuTextureBytes: sum(resident, (file) => num(file?.gpuBytes)),
    largestTexture: max(Object.values(files), (file) => num(file.largestTexture)),
    largestNonFloorTexture: max(Object.values(files), (file) => num(file.largestNonFloorTexture)),
    firstFrameBytes: sum(firstFrame, (file) => num(file?.bytes)),
    furtherLookBytes: max(further, (look) => num(look.bytes)),
  };

  const rows = Object.keys(ROW_LABELS).map((key) => ({
    key,
    label: ROW_LABELS[key],
    actual: actual[key],
    target: targets[key],
    unit: BYTE_ROWS.has(key) ? 'bytes' : 'count',
    pass: actual[key] <= targets[key],
  }));

  const info = {
    allFilesGpuBytes: sum(Object.values(files), (file) => num(file.gpuBytes)),
    allFilesBytes: sum(Object.values(files), (file) => num(file.bytes)),
    heaviestLookByGpu: heaviestGpu(lookEntries)?.name ?? null,
    heaviestLookByTriangles: heaviestTriangles?.name ?? null,
  };
  return { rows, info };
}

/** The budget table as plain text, actual against target, one line per row. */
export function formatBudgetTable(set, rows, info) {
  const lines = [];
  lines.push(`budget: ${set} set`);
  lines.push(`  ${'row'.padEnd(52)} ${'actual'.padStart(12)} ${'target'.padStart(12)}  verdict`);
  for (const row of rows) {
    const actual = row.unit === 'bytes' ? formatMb(row.actual) : String(row.actual);
    const target = row.unit === 'bytes' ? formatMb(row.target) : String(row.target);
    lines.push(
      `  ${row.label.padEnd(52)} ${actual.padStart(12)} ${target.padStart(12)}  ${row.pass ? 'ok' : 'MISS'}`,
    );
  }
  if (info) {
    lines.push(`  note: all files together ${formatMb(info.allFilesGpuBytes)} on the GPU, ` +
      `${formatMb(info.allFilesBytes)} on disk`);
    lines.push(`  note: heaviest look by GPU bytes ${info.heaviestLookByGpu ?? '-'}, ` +
      `by triangles ${info.heaviestLookByTriangles ?? '-'}`);
  }
  return lines.join('\n');
}

/** Bytes as MB with two decimals, the same unit inspect.mjs prints. */
export function formatMb(bytes) {
  return `${(bytes / MB).toFixed(2)} MB`;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function sum(items, pick) {
  return items.reduce((total, item) => total + pick(item), 0);
}

function max(items, pick) {
  return items.reduce((best, item) => Math.max(best, pick(item)), 0);
}

function maxBy(items, pick) {
  let best = null;
  for (const item of items) if (best === null || pick(item) > pick(best)) best = item;
  return best;
}

function heaviestGpu(lookEntries) {
  return maxBy(lookEntries, (look) => num(look.gpuBytes));
}
