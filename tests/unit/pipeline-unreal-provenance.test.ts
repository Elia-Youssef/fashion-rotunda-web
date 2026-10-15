import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { unrealProject } from '../../pipeline/config.mjs';
import {
  assertMatchingManifests,
  assertNewIsolatedOutput,
  exportEvidenceRoot,
  hashTree,
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
