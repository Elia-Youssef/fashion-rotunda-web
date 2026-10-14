// The upload plan: the exact wrangler commands that would put the manifest's objects into R2,
// computed and printed only. This module has no apply mode and no process spawner; it reads a
// built manifest and turns it into text.

/**
 * Every uploaded object carries the immutable one-year cache rule. It is safe for the
 * content-addressed keys by construction, because a changed file hashes to a different key. The
 * two fixed transcoder keys are the exception, accepted because that pair changes only with a
 * three.js upgrade, and an upgrade that changes those bytes ships with a key change of its own.
 */
export const CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** The bucket the printed commands address until the real one exists; --bucket overrides it. */
export const DEFAULT_BUCKET = 'fashion-rotunda-content';

/** Where the content files live relative to the repository root, as --file paths show it. */
export const DEFAULT_FILE_BASE = 'public/content';

/**
 * Object keys out of an already-uploaded list file: one key per line, blank lines and lines
 * starting with # ignored, so the file can carry notes.
 */
export function parseUploadedList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function requireString(value, what) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`a manifest file entry has no ${what}`);
  }
}

function putCommand(bucket, key, entry, fileBase) {
  const file = `${fileBase}/${entry.path}`;
  for (const part of [bucket, key, file, entry.contentType]) {
    if (/\s|"/.test(part)) {
      throw new Error(`a command segment would not survive the shell as one argument: ${part}`);
    }
  }
  return (
    `wrangler r2 object put ${bucket}/${key} --file ${file}` +
    ` --content-type ${entry.contentType} --cache-control "${CACHE_CONTROL}"`
  );
}

/**
 * One command per object key, not per file: entries that share a key share bytes, so the first
 * path in manifest order stands in for all of them and the rest are listed as shared paths.
 * Keys named in `uploaded` are reported as skipped instead of planned again.
 */
export function planUploads(manifest, { bucket, uploaded = [], fileBase = DEFAULT_FILE_BASE }) {
  if (!Array.isArray(manifest.files)) {
    throw new Error('the manifest has no files array');
  }
  const groups = new Map();
  for (const entry of manifest.files) {
    requireString(entry?.path, 'path');
    requireString(entry?.key, 'key');
    requireString(entry?.contentType, 'contentType');
    const group = groups.get(entry.key);
    if (group === undefined) {
      groups.set(entry.key, { entry, paths: [entry.path] });
    } else {
      group.paths.push(entry.path);
    }
  }
  const alreadyThere = new Set(uploaded);
  const commands = [];
  const skipped = [];
  for (const [key, group] of groups) {
    if (alreadyThere.has(key)) {
      skipped.push({ key, paths: group.paths });
      continue;
    }
    commands.push(putCommand(bucket, key, group.entry, fileBase));
  }
  return {
    commands,
    skipped,
    counts: {
      files: manifest.files.length,
      objects: groups.size,
      toUpload: commands.length,
      skipped: skipped.length,
    },
  };
}

/** The plan as one deterministic text block: a summary comment, skip notes, then the commands. */
export function renderPlanText(plan) {
  const lines = [
    `# ${plan.counts.files} files, ${plan.counts.objects} objects,` +
      ` ${plan.counts.skipped} already uploaded, ${plan.counts.toUpload} to upload`,
  ];
  for (const skip of plan.skipped) {
    lines.push(`# skipped (already uploaded): ${skip.key} (${skip.paths.length} paths: ${skip.paths.join(', ')})`);
  }
  lines.push(...plan.commands);
  return `${lines.join('\n')}\n`;
}
