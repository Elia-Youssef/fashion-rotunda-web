import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { unrealProject } from '../../pipeline/config.mjs';
import {
  assertMatchingManifests,
  assertNewIsolatedOutput,
  exportEvidenceRoot,
  hashTree,
} from '../../pipeline/unreal/provenance.mjs';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Unreal export provenance safeguards', () => {
  it('uses the relocated authoritative project unless explicitly overridden', () => {
    expect(unrealProject).toBe(resolve(
      process.env.FR_UNREAL_PROJECT ?? 'C:\\Users\\User\\Documents\\Unreal Projects\\FashionRotunda\\FashionRotunda.uproject',
    ));
  });

  it('accepts only a new child of the isolated evidence root', () => {
    const allowed = resolve(exportEvidenceRoot, 'test-new-output');
    expect(assertNewIsolatedOutput(allowed)).toBe(allowed);
    expect(() => assertNewIsolatedOutput(exportEvidenceRoot)).toThrow(/child/);
    expect(() => assertNewIsolatedOutput(resolve(exportEvidenceRoot, '..', 'not-evidence'))).toThrow(/child/);
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
