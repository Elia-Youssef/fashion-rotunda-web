// Read-only provenance helpers for the Unreal export route.  This module deliberately has no
// Unreal dependency: it can prove the selected paths and preserve the known-good tree even where
// the editor is unavailable.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import { contentDir, root, sourceDir } from '../config.mjs';

export const exportEvidenceRoot = resolve(root, 'briefs', 'reports', 'export-provenance');
export const knownGoodTrees = Object.freeze([
  resolve(sourceDir, 'unreal'),
  contentDir,
]);

function isRelativeChild(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation.length > 0 && !relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation);
}

/** Resolve and require a new export destination below the immutable-evidence root. */
export function assertNewIsolatedOutput(candidate) {
  const output = resolve(candidate);
  if (!isRelativeChild(exportEvidenceRoot, output)) {
    throw new Error(`export output must be a child of ${exportEvidenceRoot}; received ${output}`);
  }
  if (existsSync(output)) {
    throw new Error(`export output already exists; refusing to overwrite ${output}`);
  }
  return output;
}

/** Creates a unique evidence directory.  A collision is an error, never an overwrite. */
export function createEvidenceRun(now = new Date(), entropy = randomBytes(4).toString('hex')) {
  const stamp = now.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
  const runDirectory = resolve(exportEvidenceRoot, `export-${stamp}-${entropy}`);
  if (existsSync(runDirectory)) {
    throw new Error(`evidence directory already exists; refusing to overwrite ${runDirectory}`);
  }
  mkdirSync(exportEvidenceRoot, { recursive: true });
  mkdirSync(runDirectory);
  return {
    runDirectory,
    outputDirectory: assertNewIsolatedOutput(resolve(runDirectory, 'isolated-export-output')),
  };
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A stable, content-addressed manifest.  Symbolic links are recorded as links rather than followed,
 * so an audit cannot escape the selected tree.
 */
export function hashTree(directory) {
  const absoluteDirectory = resolve(directory);
  if (!existsSync(absoluteDirectory)) {
    return { path: absoluteDirectory, exists: false, files: 0, bytes: 0, digest: null, entries: [] };
  }

  const entries = [];
  const visit = (current) => {
    for (const name of readdirSync(current).sort((left, right) => left.localeCompare(right))) {
      const path = resolve(current, name);
      const status = lstatSync(path);
      const relativePath = relative(absoluteDirectory, path).split(sep).join('/');
      if (status.isDirectory()) {
        visit(path);
      } else if (status.isSymbolicLink()) {
        entries.push({ path: relativePath, type: 'symlink', bytes: 0, sha256: digest(readlinkSync(path)) });
      } else if (status.isFile()) {
        entries.push({ path: relativePath, type: 'file', bytes: status.size, sha256: digest(readFileSync(path)) });
      } else {
        entries.push({ path: relativePath, type: 'other', bytes: 0, sha256: null });
      }
    }
  };
  visit(absoluteDirectory);

  const canonical = entries.map((entry) => `${entry.type}\0${entry.path}\0${entry.bytes}\0${entry.sha256 ?? ''}\n`).join('');
  return {
    path: absoluteDirectory,
    exists: true,
    files: entries.filter((entry) => entry.type === 'file').length,
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    digest: digest(canonical),
    entries,
  };
}

export function hashKnownGoodTrees() {
  return Object.fromEntries(knownGoodTrees.map((tree) => [basename(tree), hashTree(tree)]));
}

export function projectInventory(project) {
  const absoluteProject = resolve(project);
  const projectDirectory = resolve(absoluteProject, '..');
  const immediateEntries = existsSync(projectDirectory)
    ? readdirSync(projectDirectory).sort((left, right) => left.localeCompare(right)).map((name) => {
      const path = resolve(projectDirectory, name);
      const status = lstatSync(path);
      return {
        name,
        type: status.isDirectory() ? 'directory' : status.isFile() ? 'file' : 'other',
        bytes: status.isFile() ? status.size : null,
        modifiedAt: status.mtime.toISOString(),
      };
    })
    : [];
  return {
    path: absoluteProject,
    exists: existsSync(absoluteProject),
    sha256: existsSync(absoluteProject) ? digest(readFileSync(absoluteProject)) : null,
    projectDirectory,
    immediateEntries,
  };
}

export function assertMatchingManifests(before, after, label) {
  if (before.digest !== after.digest || before.files !== after.files || before.bytes !== after.bytes) {
    throw new Error(`${label} changed during the export audit`);
  }
}
