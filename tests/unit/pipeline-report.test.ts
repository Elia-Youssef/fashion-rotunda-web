import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const reportUrl = pathToFileURL(resolve('pipeline/gltf/report.mjs')).href;
const temporaryPrefix = resolve(tmpdir(), 'rotunda-report-');
const directories: string[] = [];
const MB = 1_000_000; // Decimal megabytes, the loading screen's unit.
const catalog = { looks: [{ file: 'looks/first.glb' }] };
const labels = [
  'rotunda plus plinth, triangles',
  'heaviest look incl. mannequin, triangles',
  'triangles in view, main pass (upper bound)',
  'draw calls, rotunda + plinth + one look',
  'texture memory on the GPU, resident',
  'largest texture (SM_Floor_A allowed the wider cap)',
  'largest texture, other materials',
  'payload to first frame',
  'heaviest further look',
];
const targets = {
  full: ['200000', '340000', '450000', '150', '400.00 MB', '4096', '2048', '10.00 MB', '6.00 MB'],
  half: ['200000', '120000', '300000', '80', '150.00 MB', '2048', '1024', '6.00 MB', '3.50 MB'],
};
type SetName = keyof typeof targets;

function files() {
  return {
    'rotunda.glb': {
      triangles: 100, drawCalls: 1, gpuBytes: MB, bytes: MB,
      largestTexture: 512, largestNonFloorTexture: 256,
    },
    'plinth.glb': { triangles: 200, drawCalls: 2, gpuBytes: MB, bytes: MB },
    'looks/first.glb': { triangles: 400, drawCalls: 3, gpuBytes: MB, bytes: MB },
    'looks/further.glb': { triangles: 500, drawCalls: 4, gpuBytes: 2 * MB, bytes: 2 * MB },
  };
}

function manifest(set: SetName, entries = files(), errors: string[] = []) {
  return { generated: '2026-10-09T00:00:00Z', sets: { [set]: { files: entries } }, errors };
}

function run(input?: ReturnType<typeof manifest>, args: string[] = []) {
  const directory = mkdtempSync(temporaryPrefix);
  directories.push(directory);
  if (input) {
    writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(input));
    writeFileSync(resolve(directory, 'catalog.json'), JSON.stringify(catalog));
  }
  const script = `import { runReport } from ${JSON.stringify(reportUrl)};` +
    `runReport(${JSON.stringify(directory)}, ${JSON.stringify(args)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8', timeout: 10_000,
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  return result;
}

function printedRows(stdout: string) {
  return stdout.split(/\r?\n/).filter((line) => / {2}(ok|MISS)$/.test(line)).map((line) => {
    const fields = line.trim().split(/\s{2,}/);
    expect(fields).toHaveLength(4);
    return fields;
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(temporaryPrefix)) throw new Error('Unexpected fixture directory');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('report output', () => {
  it.each(['full', 'half'] as const)('prints every %s row with its actual, target and passing verdict', (set) => {
    const { stdout } = run(manifest(set));
    const actual = ['300', '500', '800', '7', '4.00 MB', '512', '256', '3.00 MB', '2.00 MB'];
    expect(stdout).toContain('report: manifest generated 2026-10-09T00:00:00Z, first look looks/first.glb');
    expect(stdout).toContain(`budget: ${set} set`);
    expect(printedRows(stdout)).toEqual(labels.map((label, index) => [label, actual[index], targets[set][index], 'ok']));
    expect(stdout).toContain('report: every budget row inside its target');
  });

  it.each([
    ['full', -1], ['full', 0], ['full', 1],
    ['half', -1], ['half', 0], ['half', 1],
  ] as const)('prints MISS exactly above the target: %s offset %i', (set, offset) => {
    // Each fixture moves one measured row below, onto or above its target. Related rows may also miss.
    const limits = set === 'full'
      ? [200000, 340000, 450000, 150, 400 * MB, 4096, 2048, 10 * MB, 6 * MB]
      : [200000, 120000, 300000, 80, 150 * MB, 2048, 1024, 6 * MB, 3.5 * MB];
    for (let index = 0; index < labels.length; index++) {
      const entries = files();
      const value = limits[index]! + offset;
      switch (index) {
        case 0: entries['rotunda.glb'].triangles = value - 200; break;
        case 1: entries['looks/further.glb'].triangles = value; break;
        case 2: entries['looks/further.glb'].triangles = value - 300; break;
        case 3: entries['rotunda.glb'].drawCalls = value - 6; break;
        case 4: entries['rotunda.glb'].gpuBytes = value - 3 * MB; break;
        case 5: entries['rotunda.glb'].largestTexture = value; break;
        case 6: entries['rotunda.glb'].largestNonFloorTexture = value; break;
        case 7: entries['rotunda.glb'].bytes = value - 2 * MB; break;
        case 8: entries['looks/further.glb'].bytes = value; break;
      }
      const { stdout } = run(manifest(set, entries));
      const rows = printedRows(stdout);
      expect(rows[index]?.[0]).toBe(labels[index]);
      expect(rows[index]?.[3], `${labels[index]} at ${value}`).toBe(offset > 0 ? 'MISS' : 'ok');
      const misses = rows.filter((row) => row[3] === 'MISS').length;
      expect(stdout).toContain(misses === 0 ? 'report: every budget row inside its target'
        : `report: ${misses} budget row(s) over target`);
    }
  });

  it('prints decimal megabytes rounded to two places, including zero and a rounded-up boundary', () => {
    const entries = files();
    entries['rotunda.glb'].gpuBytes = 1_234_567;
    entries['plinth.glb'].gpuBytes = 0;
    entries['looks/first.glb'].gpuBytes = 0;
    entries['looks/further.glb'].gpuBytes = 0;
    entries['rotunda.glb'].bytes = 0;
    entries['plinth.glb'].bytes = 0;
    entries['looks/first.glb'].bytes = 0;
    entries['looks/further.glb'].bytes = 3_499_999;
    const { stdout } = run(manifest('half', entries));
    const rows = printedRows(stdout);
    expect(rows[4]).toEqual([labels[4], '1.23 MB', '150.00 MB', 'ok']);
    expect(rows[7]).toEqual([labels[7], '0.00 MB', '6.00 MB', 'ok']);
    expect(rows[8]).toEqual([labels[8], '3.50 MB', '3.50 MB', 'ok']);
    expect(stdout).toContain('note: all files together 1.23 MB on the GPU, 3.50 MB on disk');
  });

  it.each(['pass', 'miss', 'texture errors', 'missing inputs'] as const)(
    'exits successfully for %s', (scenario) => {
      const entries = files();
      if (scenario === 'miss') entries['rotunda.glb'].bytes = 11 * MB;
      const input = scenario === 'missing inputs' ? undefined
        : manifest('full', entries, scenario === 'texture errors' ? ['texture encoding failed'] : []);
      const { status, stdout } = run(input);
      if (scenario === 'miss') expect(stdout).toContain('report: 1 budget row(s) over target');
      if (scenario === 'texture errors') expect(stdout).toContain('report: 1 texture error(s) recorded');
      if (scenario === 'missing inputs') expect(stdout).toContain('report: skipped, no manifest');
      if (scenario === 'pass') expect(stdout).toContain('report: every budget row inside its target');
      expect(status).toBe(0);
    },
  );
});
