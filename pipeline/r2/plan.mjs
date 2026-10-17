// Prints the wrangler commands that would upload the manifest's objects, and runs none of them:
// the planner has no apply mode. The commands address remote storage by default (wrangler only
// uploads to a local simulator with --local, which these lines never carry); review the lines,
// then run them by hand when the bucket and the account exist.
//
//   node pipeline/r2/plan.mjs [--manifest FILE] [--bucket NAME] [--uploaded FILE] [--content-dir DIR]
//
// --uploaded names a text file of object keys already in the bucket, one per line with #
// comments allowed; those keys are reported as skipped instead of printed again.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { workDir } from '../config.mjs';
import { DEFAULT_BUCKET, DEFAULT_FILE_BASE, parseUploadedList, planUploads, renderPlanText } from './lib/plan.mjs';

function valueOf(args, name) {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : undefined;
}

function readInput(path, label, parse) {
  try {
    return parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} could not be read at ${path}: ${error.message}`, { cause: error });
  }
}

const args = process.argv.slice(2);
const manifestPath = resolve(valueOf(args, '--manifest') ?? resolve(workDir, 'r2', 'manifest.json'));
const bucket = valueOf(args, '--bucket') ?? process.env.FR_R2_BUCKET ?? DEFAULT_BUCKET;
const uploadedPath = valueOf(args, '--uploaded');
const fileBase = valueOf(args, '--content-dir') ?? DEFAULT_FILE_BASE;

const manifest = readInput(manifestPath, 'the manifest', JSON.parse);
const uploaded = uploadedPath === undefined
  ? []
  : readInput(resolve(uploadedPath), 'the uploaded list', parseUploadedList);

console.log(renderPlanText(planUploads(manifest, { bucket, uploaded, fileBase })));
