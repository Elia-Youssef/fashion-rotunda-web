import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { unrealProject } from '../../pipeline/config.mjs';
import {
  assertMatchingManifests,
  assertNewIsolatedOutput,
  exportEvidenceRoot,
  hashKnownGoodTrees,
  hashTree,
  projectInventory,
} from '../../pipeline/unreal/provenance.mjs';

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Unreal export provenance safeguards', () => {
  it.each([
    { label: 'default', override: undefined },
    { label: 'absolute override', override: resolve(tmpdir(), 'custom-provenance') },
    { label: 'relative override', override: 'custom-provenance' },
  ])('uses the configured evidence directory with $label', async ({ override }) => {
    vi.stubEnv('FR_PROVENANCE_DIR', override);
    vi.resetModules();
    const config = await import('../../pipeline/config.mjs');
    const provenance = await import('../../pipeline/unreal/provenance.mjs');
    const expected = override === undefined
      ? resolve(config.workDir, 'export-provenance')
      : resolve(override);
    expect(config.provenanceDir).toBe(expected);
    expect(provenance.exportEvidenceRoot).toBe(expected);
    expect(provenance.assertNewIsolatedOutput(resolve(expected, 'new-run')))
      .toBe(resolve(expected, 'new-run'));
  });

  it('uses a known location of the authoritative project unless explicitly overridden', () => {
    const known = [
      'C:\\Users\\User\\Documents\\Unreal Projects\\FashionRotunda\\FashionRotunda.uproject',
      'E:\\Fashion-Rotunda-WebGPU\\FashionRotunda\\FashionRotunda.uproject',
    ].map((path) => resolve(path));
    const expected = process.env.FR_UNREAL_PROJECT ? [resolve(process.env.FR_UNREAL_PROJECT)] : known;
    expect(expected).toContain(unrealProject);
  });

  it('accepts only a new child of the isolated evidence root', () => {
    const allowed = resolve(exportEvidenceRoot, 'test-new-output');
    expect(assertNewIsolatedOutput(allowed)).toBe(allowed);
    expect(() => assertNewIsolatedOutput(exportEvidenceRoot)).toThrow(/child/);
    expect(() => assertNewIsolatedOutput(resolve(exportEvidenceRoot, '..', 'not-evidence'))).toThrow(/child/);
  });

  it('refuses an export output that already exists, without overwriting it', async () => {
    const evidence = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-provenance-'));
    temporaryDirectories.push(evidence);
    mkdirSync(resolve(evidence, 'existing-run'));
    writeFileSync(resolve(evidence, 'existing-run', 'evidence.txt'), 'kept', 'utf8');
    vi.stubEnv('FR_PROVENANCE_DIR', evidence);
    vi.resetModules();
    const provenance = await import('../../pipeline/unreal/provenance.mjs');
    expect(() => provenance.assertNewIsolatedOutput(resolve(evidence, 'existing-run')))
      .toThrow(`export output already exists; refusing to overwrite ${resolve(evidence, 'existing-run')}`);
  });

  it('refuses a colliding evidence run directory', async () => {
    const evidence = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-provenance-'));
    temporaryDirectories.push(evidence);
    vi.stubEnv('FR_PROVENANCE_DIR', evidence);
    vi.resetModules();
    const provenance = await import('../../pipeline/unreal/provenance.mjs');
    const now = new Date('2026-10-15T12:00:00.000Z');
    const first = provenance.createEvidenceRun(now, 'cafe01');
    expect(first.runDirectory).toBe(resolve(evidence, 'export-20261015T120000000Z-cafe01'));
    expect(() => provenance.createEvidenceRun(now, 'cafe01'))
      .toThrow(`evidence directory already exists; refusing to overwrite ${first.runDirectory}`);
  });

  it('hashes a stable tree and fails closed when its manifest changes', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-provenance-'));
    temporaryDirectories.push(directory);
    writeFileSync(resolve(directory, 'asset.txt'), 'before', 'utf8');
    const before = hashTree(directory);
    expect(hashTree(directory)).toMatchObject({ digest: before.digest, files: 1, bytes: 6 });

    writeFileSync(resolve(directory, 'asset.txt'), 'after', 'utf8');
    const after = hashTree(directory);
    expect(() => assertMatchingManifests(before, after, 'fixture')).toThrow(/changed/);
  });
});

describe('Unreal provenance manifests and evidence runs', () => {
  it('records symbolic links as links instead of following them', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-provenance-'));
    temporaryDirectories.push(directory);
    mkdirSync(resolve(directory, 'real'), { recursive: true });
    writeFileSync(resolve(directory, 'real', 'inside.txt'), 'target bytes', 'utf8');
    // A junction keeps the fixture unprivileged on Windows; other platforms create a plain symlink.
    symlinkSync('real', resolve(directory, 'link'), 'junction');
    const tree = hashTree(directory);
    expect(tree.entries).toEqual([
      {
        path: 'link',
        type: 'symlink',
        bytes: 0,
        sha256: createHash('sha256').update(readlinkSync(resolve(directory, 'link'))).digest('hex'),
      },
      {
        path: 'real/inside.txt',
        type: 'file',
        bytes: 12,
        sha256: createHash('sha256').update('target bytes').digest('hex'),
      },
    ]);
    expect(tree.files).toBe(1);
  });

  it('walks nested directories in sorted order with forward-slash entry paths', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-provenance-'));
    temporaryDirectories.push(directory);
    mkdirSync(resolve(directory, 'nested'));
    writeFileSync(resolve(directory, 'b.txt'), 'second', 'utf8');
    writeFileSync(resolve(directory, 'a.txt'), 'first', 'utf8');
    writeFileSync(resolve(directory, 'nested', 'deep.txt'), 'deep', 'utf8');
    const tree = hashTree(directory);
    expect(tree.entries.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt', 'nested/deep.txt']);
    expect(tree.files).toBe(3);
  });

  it('counts files, sums their bytes and pins the canonical manifest digest', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-provenance-'));
    temporaryDirectories.push(directory);
    writeFileSync(resolve(directory, 'empty.txt'), '', 'utf8');
    writeFileSync(resolve(directory, 'full.txt'), '12345', 'utf8');
    const tree = hashTree(directory);
    expect(tree.files).toBe(2);
    expect(tree.bytes).toBe(5);
    // The canonical manifest line is the cross-run contract: type NUL path NUL bytes NUL sha256 LF.
    const line = (path: string, bytes: number, sha256: string): string =>
      `file\0${path}\0${bytes}\0${sha256}\n`;
    const fileDigest = (contents: string): string =>
      createHash('sha256').update(contents).digest('hex');
    const canonical = line('empty.txt', 0, fileDigest('')) + line('full.txt', 5, fileDigest('12345'));
    expect(tree.digest).toBe(createHash('sha256').update(canonical).digest('hex'));
  });

  it('reports an absent directory as a missing manifest', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-provenance-'));
    temporaryDirectories.push(directory);
    const absent = resolve(directory, 'absent');
    expect(hashTree(absent)).toEqual({
      path: absent,
      exists: false,
      files: 0,
      bytes: 0,
      digest: null,
      entries: [],
    });
  });

  it('derives the same manifest digest for identical content at different paths', () => {
    const first = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-provenance-'));
    const second = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-provenance-'));
    temporaryDirectories.push(first, second);
    writeFileSync(resolve(first, 'same.txt'), 'identical', 'utf8');
    writeFileSync(resolve(second, 'same.txt'), 'identical', 'utf8');
    expect(hashTree(second).digest).toBe(hashTree(first).digest);
  });

  it('keys the known-good manifests by tree name', () => {
    expect(Object.keys(hashKnownGoodTrees())).toEqual(['unreal', 'content']);
  });

  it('creates a missing evidence root and derives a fresh run name and isolated output', async () => {
    const parent = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-provenance-'));
    temporaryDirectories.push(parent);
    vi.stubEnv('FR_PROVENANCE_DIR', resolve(parent, 'evidence-root'));
    vi.resetModules();
    const provenance = await import('../../pipeline/unreal/provenance.mjs');
    const run = provenance.createEvidenceRun();
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    expect(basename(run.runDirectory))
      .toMatch(new RegExp(`^export-${today}T\\d{6}\\d{3}Z-[0-9a-f]{8}$`));
    expect(existsSync(run.runDirectory)).toBe(true);
    expect(run.outputDirectory).toBe(resolve(run.runDirectory, 'isolated-export-output'));
  });

  it('rejects the evidence root itself and its parent directory as outputs', async () => {
    const evidence = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-provenance-'));
    temporaryDirectories.push(evidence);
    vi.stubEnv('FR_PROVENANCE_DIR', evidence);
    vi.resetModules();
    const provenance = await import('../../pipeline/unreal/provenance.mjs');
    expect(() => provenance.assertNewIsolatedOutput(evidence)).toThrow(/child/);
    expect(() => provenance.assertNewIsolatedOutput(resolve(evidence, '..'))).toThrow(/child/);
  });

  it('rejects relative escapes that climb above the evidence root', async () => {
    const evidence = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-provenance-'));
    temporaryDirectories.push(evidence);
    vi.stubEnv('FR_PROVENANCE_DIR', evidence);
    vi.resetModules();
    const provenance = await import('../../pipeline/unreal/provenance.mjs');
    expect(() => provenance.assertNewIsolatedOutput(resolve(evidence, '..', 'escaping-output')))
      .toThrow(/child/);
  });

  it('rejects an absolute candidate from outside the evidence root', async () => {
    const evidence = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-provenance-'));
    temporaryDirectories.push(evidence);
    vi.stubEnv('FR_PROVENANCE_DIR', evidence);
    vi.resetModules();
    const provenance = await import('../../pipeline/unreal/provenance.mjs');
    // On Windows a relation across drives comes back absolute, which is the case this check owns;
    // on POSIX the candidate joins the working directory and the climb above still rejects it.
    expect(() => provenance.assertNewIsolatedOutput('Q:\\fashion-rotunda-escaping-output'))
      .toThrow(/child/);
  });

  it('inventories the project directory and the project file without following either', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'fashion-rotunda-provenance-'));
    temporaryDirectories.push(root);
    mkdirSync(resolve(root, 'subdir'));
    writeFileSync(resolve(root, 'asset.txt'), 'xyz', 'utf8');
    const absent = projectInventory(resolve(root, 'absent.uproject'));
    expect(absent).toMatchObject({
      path: resolve(root, 'absent.uproject'),
      exists: false,
      sha256: null,
      projectDirectory: root,
    });
    expect(absent.immediateEntries).toEqual([
      { name: 'asset.txt', type: 'file', bytes: 3, modifiedAt: expect.any(String) },
      { name: 'subdir', type: 'directory', bytes: null, modifiedAt: expect.any(String) },
    ]);
    expect(projectInventory(resolve(root, 'gone', 'absent.uproject')).immediateEntries)
      .toEqual([]);
    const present = projectInventory(resolve(root, 'asset.txt'));
    expect(present).toMatchObject({ exists: true, projectDirectory: root });
    expect(present.sha256).toBe(createHash('sha256').update('xyz').digest('hex'));
    for (const entry of absent.immediateEntries) {
      expect(entry.modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it('fails closed when any manifest column changes on its own', () => {
    const manifest = (digest: string, files: number, bytes: number) => ({
      path: 'tree',
      exists: true,
      digest,
      files,
      bytes,
      entries: [],
    });
    expect(() => assertMatchingManifests(manifest('d', 2, 10), manifest('d', 3, 10), 'fixture'))
      .toThrow(/changed/);
    expect(() => assertMatchingManifests(manifest('d', 2, 10), manifest('d', 2, 11), 'fixture'))
      .toThrow(/changed/);
    expect(() => assertMatchingManifests(manifest('a', 2, 10), manifest('b', 2, 10), 'fixture'))
      .toThrow(/changed/);
    expect(assertMatchingManifests(manifest('d', 2, 10), manifest('d', 2, 10), 'fixture'))
      .toBeUndefined();
  });
});
