// The budget report: every row of the project budget table, actual against target, read from the
// manifest the optimize pass wrote. It never fails the gate, because the budgets are targets that the
// measurements correct; a MISS is printed so it is seen, and the pass keeps shipping.
//
//   npm run report          both sets
//   npm run report -- half  one set

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { contentDir } from '../config.mjs';
import { budgetRows, formatBudgetTable } from './lib/budget.mjs';
import { SET_NAMES } from './lib/manifest.mjs';

const manifestPath = resolve(contentDir, 'manifest.json');
const catalogPath = resolve(contentDir, 'catalog.json');

if (!existsSync(manifestPath) || !existsSync(catalogPath)) {
  console.log(`report: skipped, no manifest at ${manifestPath} (run npm run pipeline:optimize first)`);
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const firstLook = catalog.looks[0]?.file ?? null;
const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const sets = wanted.length > 0 ? wanted : SET_NAMES;

console.log(`report: manifest generated ${manifest.generated}, first look ${firstLook ?? 'none'}`);
let misses = 0;
for (const set of sets) {
  const files = manifest.sets?.[set]?.files;
  if (!files) {
    console.log(`report: no ${set} set in the manifest`);
    continue;
  }
  const { rows, info } = budgetRows(set, files, firstLook);
  console.log(formatBudgetTable(set, rows, info));
  misses += rows.filter((row) => !row.pass).length;
}
if (manifest.errors?.length) {
  console.log(`report: ${manifest.errors.length} texture error(s) recorded in the manifest`);
}
console.log(misses === 0 ? 'report: every budget row inside its target' : `report: ${misses} budget row(s) over target`);
