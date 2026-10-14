// Content addressing for the R2 object layout: which files under the content root are runtime
// content, what MIME type each carries, and which object key each uploads under.
//
// Object keys are content-addressed, `content/<sha256>.<ext>`: an object is named by the SHA-256
// of its bytes, so a changed file is a new object and an unchanged file keeps its URL forever,
// which is what makes the immutable cache header safe. Two files with identical bytes share one
// key and one upload. One class of files cannot follow the rule: three's KTX2Loader takes a
// directory from setTranscoderPath and appends the fixed names basis_transcoder.js and
// basis_transcoder.wasm itself (KTX2Loader.js loads 'basis_transcoder.js' and
// 'basis_transcoder.wasm' under that path), so the transcoder pair keeps fixed keys under
// content/basis/ and the page's loader contract stays unchanged.

import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

/** MIME type by extension. An extension missing from this table stops the build instead of
 *  uploading a guessed type, because the type becomes the object's Content-Type header. */
export const CONTENT_TYPES = {
  '.glb': 'model/gltf+binary',
  '.hdr': 'image/vnd.radiance',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
};

/**
 * Files whose object key cannot carry the hash because a consumer asks for them by a fixed
 * directory and name rather than by content. Three's KTX2Loader is that consumer today: it
 * appends its own file names to the transcoder directory, so those files keep the names the
 * loader requests under content/basis/.
 */
export const FIXED_KEY_BY_PATH = {
  'basis/basis_transcoder.js': 'content/basis/basis_transcoder.js',
  'basis/basis_transcoder.wasm': 'content/basis/basis_transcoder.wasm',
};

/**
 * Runtime-content exclusions: files under the content root that the page never fetches, each with
 * the reason it stays out of the upload set. Empty today: every file under public/content is
 * reached by the page's fetch chain, namely the two catalogues, the manifest the entry lobby
 * reads, the collision mesh, the optional environment HDR, the music list and both formats of
 * its track, the transcoder pair, and the rotunda, plinth, looks and thumbnails the catalogues
 * name. A new file the page never fetches gets an entry here, with its reason, never a silent
 * skip: what is not listed is uploaded.
 */
export const EXCLUDED_FILES = [];

/** The object key for one content file: fixed where a consumer needs a directory, hashed otherwise. */
export function objectKeyFor(path, sha256) {
  const fixed = FIXED_KEY_BY_PATH[path];
  if (fixed !== undefined) {
    return fixed;
  }
  const ext = extname(path).toLowerCase().slice(1);
  if (ext === '') {
    throw new Error(`a content file without an extension has no addressable key: ${path}`);
  }
  return `content/${sha256}.${ext}`;
}

/** The MIME type stored with the object. Unknown extensions stop the build. */
export function contentTypeFor(path) {
  const type = CONTENT_TYPES[extname(path).toLowerCase()];
  if (type === undefined) {
    throw new Error(
      `no content type is known for ${path}; add its extension to CONTENT_TYPES in pipeline/r2/lib/objects.mjs`,
    );
  }
  return type;
}

/** SHA-256 of a file's bytes as lowercase hex, the digest R2 object keys are named with. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The reason a path is excluded from the upload set, or null when it is runtime content. A rule
 * matches by exact path or by folder prefix; the first matching rule wins.
 */
export function exclusionReasonFor(path, exclusions = EXCLUDED_FILES) {
  for (const rule of exclusions) {
    if (rule.exact !== undefined && rule.exact === path) {
      return rule.reason;
    }
    if (rule.prefix !== undefined && path.startsWith(rule.prefix)) {
      return rule.reason;
    }
  }
  return null;
}

/** Reads one directory's entries as Dirent-like objects; injectable so tests can reorder the walk. */
function defaultReaddir(dir) {
  return readdirSync(dir, { withFileTypes: true });
}

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Every regular file under root as relative POSIX paths, sorted, so the manifest does not depend
 * on the order the file system happens to return. Anything that is neither a file nor a
 * directory (a symlink, for example) stops the walk: the upload set must not grow a file the
 * tree walk cannot describe.
 */
export function walkContentFiles(root, readdir = defaultReaddir) {
  const paths = [];
  const visit = (relative) => {
    const dir = relative === '' ? root : join(root, relative);
    for (const entry of readdir(dir).slice().sort(byName)) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile()) {
        paths.push(child);
      } else {
        throw new Error(`not a regular file or directory under the content root: ${child}`);
      }
    }
  };
  visit('');
  return paths.sort();
}
