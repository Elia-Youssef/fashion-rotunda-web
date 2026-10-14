// The R2 upload manifest: one entry per runtime content file with its hash, byte size, content
// type, object key and public URL. Deterministic by construction: the walk is sorted, every field
// order is fixed by this module and no timestamp is written, so the same tree yields
// byte-identical JSON on every machine. The text itself goes through shippedJson, the same
// ASCII-escaping writer every shipped JSON file uses.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { shippedJson } from '../../gltf/lib/manifest.mjs';
import {
  contentTypeFor,
  exclusionReasonFor,
  objectKeyFor,
  sha256Hex,
  walkContentFiles,
} from './objects.mjs';

/**
 * The public origin the manifest's URLs are built on when the caller says nothing. A placeholder
 * on purpose: it is not a real bucket's domain, so a default run cannot produce URLs that look
 * deployable. The real origin comes from --origin or FR_R2_ORIGIN at run time.
 */
export const DEFAULT_ORIGIN = 'https://content.example.invalid';

/** Accepts an http(s) origin and returns it without a trailing slash, for URL joining. */
export function normalizeOrigin(origin) {
  const trimmed = origin.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/.test(trimmed)) {
    throw new Error(`the origin must be an http or https URL, got "${origin}"`);
  }
  return trimmed;
}

/**
 * Builds the manifest for one content tree.
 *
 * @param root the directory walked for runtime content (public/content, or a test fixture).
 * @param origin the public origin each entry's URL is built from.
 * @param readdir injectable directory listing, so tests can prove the walk order does not matter.
 * @param exclusions injectable exclusion rules, so tests can prove excluded files are recorded.
 */
export function buildR2Manifest({ root, origin, readdir, exclusions }) {
  const normalized = normalizeOrigin(origin);
  const files = [];
  const excluded = [];
  for (const path of walkContentFiles(root, readdir)) {
    const reason = exclusionReasonFor(path, exclusions);
    if (reason !== null) {
      excluded.push({ path, reason });
      continue;
    }
    // The type is checked before the bytes are read, so an unknown extension fails fast.
    const contentType = contentTypeFor(path);
    const bytes = readFileSync(join(root, path));
    const sha256 = sha256Hex(bytes);
    const key = objectKeyFor(path, sha256);
    files.push({ path, sha256, bytes: bytes.byteLength, contentType, key, url: `${normalized}/${key}` });
  }
  return {
    origin: normalized,
    files,
    excluded,
    totals: {
      files: files.length,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
      objects: new Set(files.map((file) => file.key)).size,
    },
  };
}

/** The manifest as shipped text: two-space indented, ASCII-escaped, newline-terminated. */
export function manifestText(manifest) {
  return shippedJson(manifest);
}
