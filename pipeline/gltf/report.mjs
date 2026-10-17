// The budget report: every row of the project budget table, actual against target, read from the
// manifest the optimize pass wrote. It never fails the gate, because the budgets are targets that the
// measurements correct; a MISS is printed so it is seen, and the pass keeps shipping.
//
//   npm run report          both sets
//   npm run report -- half  one set

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { contentDir } from '../config.mjs';
import { budgetRows, formatBudgetTable } from './lib/budget.mjs';
import { SET_NAMES } from './lib/manifest.mjs';

/** Print the report from a content directory; budget misses remain informational. */
export function runReport(directory = contentDir, args = process.argv.slice(2)) {
  const manifestPath = resolve(directory, 'manifest.json');
  const catalogPath = resolve(directory, 'catalog.json');

  if (!existsSync(manifestPath) || !existsSync(catalogPath)) {
    console.log(`report: skipped, no manifest at ${manifestPath} (run npm run pipeline:optimize first)`);
    return;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const firstLook = catalog.looks[0]?.file ?? null;
  const environment = catalog.environment?.file ?? null;
  const wanted = args.filter((arg) => !arg.startsWith('--'));
  const sets = wanted.length > 0 ? wanted : SET_NAMES;

  console.log(`report: first look ${firstLook ?? 'none'}`);
  let misses = 0;
  for (const set of sets) {
    const files = manifest.sets?.[set]?.files;
    if (!files) {
      console.log(`report: no ${set} set in the manifest`);
      continue;
    }
    const { rows, info } = budgetRows(set, files, firstLook, environment);
    console.log(formatBudgetTable(set, rows, info));
    misses += rows.filter((row) => !row.pass).length;
  }
  if (manifest.errors?.length) {
    console.log(`report: ${manifest.errors.length} texture error(s) recorded in the manifest`);
  }
  console.log(misses === 0 ? 'report: every budget row inside its target' : `report: ${misses} budget row(s) over target`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runReport();
}
