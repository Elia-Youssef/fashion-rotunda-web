// Builds the R2 object manifest from the runtime content set. Offline tooling only: it reads the
// content tree, hashes it and writes one JSON file; nothing is uploaded, no network is touched
// and public/content is never written.
//
//   node pipeline/r2/manifest.mjs [--origin URL] [--out FILE] [--content-root DIR]
//
// --origin (or FR_R2_ORIGIN) names the public origin the URLs are built on; the default is a
// placeholder, so a default run cannot produce URLs that look deployable. The manifest lands in
// assets-src/work/r2/manifest.json unless --out says otherwise.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { contentDir, workDir } from '../config.mjs';
import { buildR2Manifest, DEFAULT_ORIGIN, manifestText } from './lib/manifest.mjs';

/** Where the manifest lands when the caller says nothing: the disposable pipeline work area. */
const defaultOut = resolve(workDir, 'r2', 'manifest.json');

function valueOf(args, name) {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : undefined;
}

const args = process.argv.slice(2);
const origin = valueOf(args, '--origin') ?? process.env.FR_R2_ORIGIN ?? DEFAULT_ORIGIN;
const out = resolve(valueOf(args, '--out') ?? defaultOut);
const root = resolve(valueOf(args, '--content-root') ?? contentDir);

const manifest = buildR2Manifest({ root, origin });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, manifestText(manifest));
console.log(
  `r2 manifest: ${manifest.totals.files} files, ${manifest.totals.objects} objects,` +
    ` ${manifest.totals.bytes} bytes, ${manifest.excluded.length} excluded`,
);
console.log(`origin ${manifest.origin}`);
console.log(`wrote ${out}`);
